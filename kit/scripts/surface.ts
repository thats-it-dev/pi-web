import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";

export interface ApiSurface {
	exports: string[];
	elements: string[];
	cssProps: string[];
	events: string[];
	attributes: string[];
	files: string[];
}

const FIELDS = ["exports", "elements", "cssProps", "events", "attributes", "files"] as const;
const ENTRY_FILES = new Set(["kit.js", "lit.js", "kit.css", "kit.d.ts", "theme-init.js", "api.json"]);

/** Entries present in `prev` but gone from `next`, as "<field>:<name>". Additions are allowed. */
export function diffSurface(prev: ApiSurface, next: ApiSurface): string[] {
	return FIELDS.flatMap((field) => {
		const kept = new Set(next[field] ?? []);
		return (prev[field] ?? []).filter((name) => !kept.has(name)).map((name) => `${field}:${name}`);
	});
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...(await walk(p)));
		else out.push(p);
	}
	return out;
}

function moduleExports(srcDir: string): string[] {
	const entry = join(srcDir, "index.ts");
	const options = ts.parseJsonConfigFileContent(
		ts.readConfigFile(join(srcDir, "..", "tsconfig.json"), ts.sys.readFile).config,
		ts.sys,
		join(srcDir, ".."),
	).options;
	const program = ts.createProgram([entry], options);
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(entry);
	if (!source) throw new Error(`cannot read ${entry}`);
	const symbol = checker.getSymbolAtLocation(source);
	if (!symbol) throw new Error(`${entry} is not a module`);
	return checker.getExportsOfModule(symbol).map((s) => s.getName());
}

async function elementTags(srcDir: string): Promise<string[]> {
	const tags: string[] = [];
	for (const file of await walk(srcDir)) {
		if (!/\.ts$/.test(file) || /\.test\.ts$/.test(file)) continue;
		const text = await readFile(file, "utf8");
		for (const m of text.matchAll(/customElements\.define\(\s*["']([^"']+)["']/g)) tags.push(m[1]);
	}
	return tags;
}

async function sourceTexts(srcDir: string): Promise<string[]> {
	const out = [];
	for (const file of await walk(srcDir)) {
		if (!/\.ts$/.test(file) || /\.test\.ts$/.test(file)) continue;
		out.push(await readFile(file, "utf8"));
	}
	return out;
}

/** Custom event names the kit dispatches: `new CustomEvent("x")` literals plus the value of TOAST_EVENT. */
export function eventNames(sources: string[]): string[] {
	const names: string[] = [];
	for (const text of sources) {
		for (const m of text.matchAll(/new CustomEvent(?:<[^>(]*>)?\(\s*["']([^"']+)["']/g)) names.push(m[1]);
		for (const m of text.matchAll(/\bTOAST_EVENT\s*=\s*["']([^"']+)["']/g)) names.push(m[1]);
	}
	return names;
}

/** Public custom properties read by shadow CSS: `var(--tk-…`. */
export function shadowCssProps(sources: string[]): string[] {
	return sources.flatMap((text) => [...text.matchAll(/var\(\s*(--tk-[\w-]+)/g)].map((m) => m[1]));
}

/** "tag:attr" for each Lit static property that has an HTML attribute. */
export function litAttributes(text: string): string[] {
	const tag = /customElements\.define\(\s*["']([^"']+)["']/.exec(text)?.[1];
	if (!tag) return [];
	const source = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
	const out: string[] = [];
	const str = (n: ts.Node | undefined) => (n && ts.isStringLiteralLike(n) ? n.text : undefined);
	const visit = (node: ts.Node) => {
		if (
			ts.isPropertyDeclaration(node) &&
			node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) &&
			node.name.getText() === "properties" &&
			node.initializer &&
			ts.isObjectLiteralExpression(node.initializer)
		) {
			for (const prop of node.initializer.properties) {
				if (!ts.isPropertyAssignment(prop)) continue;
				const name = str(prop.name) ?? prop.name.getText();
				let attr: string | undefined = name.toLowerCase();
				if (ts.isObjectLiteralExpression(prop.initializer)) {
					for (const opt of prop.initializer.properties) {
						if (!ts.isPropertyAssignment(opt)) continue;
						const key = opt.name.getText();
						if (key === "state" && opt.initializer.kind === ts.SyntaxKind.TrueKeyword) attr = undefined;
						if (key === "attribute") {
							if (opt.initializer.kind === ts.SyntaxKind.FalseKeyword) attr = undefined;
							else if (str(opt.initializer) !== undefined) attr = str(opt.initializer);
						}
					}
				}
				if (attr) out.push(`${tag}:${attr}`);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return out;
}

/** What `dist` exposes today: the surface later builds may add to but never shrink. */
export async function collectSurface(distDir: string): Promise<ApiSurface> {
	const srcDir = join(dirname(distDir), "src");
	const css = await readFile(join(distDir, "kit.css"), "utf8");
	// Only the public entry points: not types/**, index.html or _headers.
	const files = (await walk(distDir))
		.map((f) => relative(distDir, f).split(sep).join("/"))
		.filter((f) => ENTRY_FILES.has(f) || f.startsWith("fonts/"));
	const texts = await sourceTexts(srcDir);
	return {
		exports: sorted(moduleExports(srcDir)),
		elements: sorted(await elementTags(srcDir)),
		cssProps: sorted([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).concat(shadowCssProps(texts))),
		events: sorted(eventNames(texts)),
		attributes: sorted(texts.flatMap(litAttributes)),
		// api.json is written after this runs, but it is published all the same
		files: sorted([...files, "api.json"]),
	};
}
