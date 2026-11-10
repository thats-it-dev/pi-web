import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renamePackage } from "./new-app.ts";
import { ORG } from "./names.ts";
import { must, type Run } from "./run.ts";

// Files the template owns. An app's copy is replaced whole, so the next sync is a clean diff.
export const OWNED_FILES = ["AGENTS.md", "test/guardrails.test.ts", ".github/workflows/deploy.yml", "scripts/gateway-url.ts"];
// Copied only when the app has none: an app adds its own entry points to it.
const SEEDED_FILES = ["knip.json"];
const OWNED_SCRIPTS = ["e2e:one", "lint", "guardrails", "verify"];
const OWNED_DEV_DEPS = ["knip"];
const WORKERS = /^([ \t]*)workers:[^\n]*,[ \t]*$/m;

export type SyncResult = { changed: string[]; notes: string[]; guardrails: { ok: boolean; output: string } };

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);

// Brings an app's guardrails level with the template: files, scripts, the knip dependency, the package
// name and Playwright's worker count. Leaves the changes uncommitted and runs `npm run guardrails`.
export async function syncTemplate(dir: string, run: Run): Promise<SyncResult> {
	if (!existsSync(join(dir, "app.config.json"))) throw new Error(`${dir} is not an app (no app.config.json)`);
	const status = await must(run, "git", ["status", "--porcelain", "--untracked-files=no"], { cwd: dir });
	if (status.trim()) throw new Error("there are uncommitted changes; commit them first so the sync is its own diff");

	const tpl = mkdtempSync(join(tmpdir(), "app-template-"));
	try {
		await must(run, "gh", ["repo", "clone", `${ORG}/app-template`, tpl, "--", "--depth", "1"]);
		const changed: string[] = [];
		const notes: string[] = [];

		for (const f of [...OWNED_FILES, ...SEEDED_FILES]) {
			const want = read(join(tpl, f));
			const have = read(join(dir, f));
			if (want === undefined || want === have) continue;
			if (have !== undefined && SEEDED_FILES.includes(f)) continue;
			mkdirSync(dirname(join(dir, f)), { recursive: true });
			writeFileSync(join(dir, f), want);
			changed.push(f);
		}

		const pkgPath = join(dir, "package.json");
		const pkgText = readFileSync(pkgPath, "utf8");
		const pkg = JSON.parse(pkgText);
		const tplPkg = JSON.parse(readFileSync(join(tpl, "package.json"), "utf8"));
		let install = false;
		pkg.scripts ??= {};
		for (const s of OWNED_SCRIPTS) if (tplPkg.scripts?.[s] !== undefined) pkg.scripts[s] = tplPkg.scripts[s];
		for (const d of OWNED_DEV_DEPS) {
			const v = tplPkg.devDependencies?.[d];
			if (v !== undefined && pkg.devDependencies?.[d] !== v && pkg.dependencies?.[d] === undefined) {
				pkg.devDependencies = { ...pkg.devDependencies, [d]: v };
				install = true;
			}
		}
		const indent = /^\{\n([ \t]+)/.exec(pkgText)?.[1] ?? "\t";
		const next = `${JSON.stringify(pkg, null, indent)}\n`;
		if (next !== pkgText) {
			writeFileSync(pkgPath, next);
			changed.push("package.json");
		}

		const name = JSON.parse(readFileSync(join(dir, "app.config.json"), "utf8")).name;
		const lockBefore = read(join(dir, "package-lock.json"));
		const pkgBefore = readFileSync(pkgPath, "utf8");
		renamePackage(dir, name);
		if (readFileSync(pkgPath, "utf8") !== pkgBefore && !changed.includes("package.json")) changed.push("package.json");

		const pw = join(dir, "playwright.config.ts");
		const workers = WORKERS.exec(read(join(tpl, "playwright.config.ts")) ?? "")?.[0].trim();
		const pwText = read(pw);
		if (workers && pwText !== undefined) {
			if (WORKERS.test(pwText)) {
				const updated = pwText.replace(WORKERS, (_, lead: string) => `${lead}${workers}`);
				if (updated !== pwText) {
					writeFileSync(pw, updated);
					changed.push("playwright.config.ts");
				}
			} else notes.push(`playwright.config.ts has no workers line; the template uses \`${workers}\``);
		}

		if (install) await must(run, "npm", ["install", "--no-audit", "--no-fund"], { cwd: dir });
		if (read(join(dir, "package-lock.json")) !== lockBefore) changed.push("package-lock.json");

		const g = await run("npm", ["run", "guardrails"], { cwd: dir, timeoutMs: 300_000 });
		const output = `${g.stdout}\n${g.stderr}`.trim().split("\n").slice(-60).join("\n");
		return { changed, notes, guardrails: { ok: g.code === 0, output } };
	} finally {
		rmSync(tpl, { recursive: true, force: true });
	}
}
