import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";

export interface ApiSurface {
	exports: string[];
	elements: string[];
	cssProps: string[];
	files: string[];
}

const FIELDS = ["exports", "elements", "cssProps", "files"] as const;

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

/** What `dist` exposes today: the surface later builds may add to but never shrink. */
export async function collectSurface(distDir: string): Promise<ApiSurface> {
	const srcDir = join(dirname(distDir), "src");
	const css = await readFile(join(distDir, "kit.css"), "utf8");
	const files = (await walk(distDir)).map((f) => relative(distDir, f).split(sep).join("/"));
	return {
		exports: sorted(moduleExports(srcDir)),
		elements: sorted(await elementTags(srcDir)),
		cssProps: sorted([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])),
		// api.json is written after this runs, but it is published all the same
		files: sorted([...files, "api.json"]),
	};
}
