// The 12 frozen tasks of the harness measurement (2026-11-24 review's protocol): four one-line changes, four features,
// two new apps, two "keep the look" refactors. Each carries a prompt phrased the way Michael writes one, a `setup`
// that builds a scratch working dir from a frozen fixture (never the real apps or website), and an `oracle` that
// passes or fails with no judge — the template's own tests and guardrails, the kit lint, a grep for the exact change,
// or a structural diff of the page. Setups copy committed trees rather than clone over the network, so the suite is
// deterministic and offline, and nothing here touches ~/workspace/apps or the real website.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const TEMPLATE = join(HOME, "workspace", "app-template");
const WEBSITE = join(HOME, "workspace", "website");
const FIX = new URL("./fixtures/", import.meta.url);

export type Size = "one-line" | "feature" | "new-app" | "keep-the-look";
export interface OracleResult {
	pass: boolean;
	detail: string;
	lintViolations?: number;
}
export interface Task {
	id: string;
	size: Size;
	prompt: string;
	setup: (dir: string) => string; // builds the working dir at exactly `dir`, returns it
	oracle: (dir: string) => OracleResult; // judge-free check of the finished tree
}

function sh(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
	try {
		return { ok: true, out: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60_000 }) };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string };
		return { ok: false, out: `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim() };
	}
}

/** A clean copy of a committed tree (no .git history, no node_modules) as its own fresh git repo, with the source's
 *  node_modules and .kit symlinked so no install is needed. */
function copyTree(source: string, dir: string, shared: string[]): string {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	execFileSync("bash", ["-c", `git -C '${source}' archive HEAD | tar -x -C '${dir}'`], { stdio: "ignore" });
	execFileSync("bash", ["-c", `cd '${dir}' && git init -q && git add -A && git -c user.name=bench -c user.email=bench@x commit -qm base`], { stdio: "ignore" });
	for (const d of shared) if (existsSync(join(source, d))) execFileSync("ln", ["-sfn", join(source, d), join(dir, d)]);
	return dir;
}

const copyTemplate = (dir: string) => copyTree(TEMPLATE, dir, ["node_modules", ".kit"]);
const copyWebsite = (dir: string) => copyTree(WEBSITE, dir, ["node_modules"]);

/** The to-do app the one-line and feature tasks start from: the template with the fixture's core, UI, unit test and
 *  spec written in and committed, so every run begins from the same green tree. The template's starter e2e is not
 *  removed; the oracles run unit tests and guardrails, not e2e. */
function todoApp(dir: string): string {
	copyTemplate(dir);
	const fix = (f: string) => readFileSync(new URL(f, FIX), "utf8");
	writeFileSync(join(dir, "src", "todo.ts"), fix("todo-core.ts"));
	writeFileSync(join(dir, "src", "app-main.ts"), fix("todo-app-main.ts"));
	writeFileSync(join(dir, "test", "todo.test.ts"), fix("todo-core.test.ts"));
	writeFileSync(join(dir, "docs", "spec.md"), fix("todo-spec.md"));
	execFileSync("bash", ["-c", `cd '${dir}' && git add -A && git -c user.name=bench -c user.email=bench@x commit -qm todo`], { stdio: "ignore" });
	return dir;
}

/** Pass when `npm run guardrails` (kit tokens + spec + the style lint + knip) and `npm test` (unit) are green: the app
 *  builds and stays on the kit. Parses the style-lint violation count from the guardrails output. */
function buildsAndOnKit(dir: string): OracleResult {
	const g = sh("npm", ["run", "guardrails"], dir);
	const lintViolations = (g.out.match(/:\d+: (?:a |the )?(?:colour|font-family|border-radius|pasted|hand-built|--tk)/g) ?? []).length;
	if (!g.ok) return { pass: false, detail: `guardrails failed${lintViolations ? ` (${lintViolations} style findings)` : ""}`, lintViolations };
	const tr = sh("npm", ["test"], dir);
	return { pass: tr.ok, detail: tr.ok ? "guardrails + unit tests green" : "unit tests failed", lintViolations: 0 };
}

/** Pass when `rel` matches `re` (the exact change the task named). */
function fileMatches(dir: string, rel: string, re: RegExp, what: string): OracleResult {
	try {
		return re.test(readFileSync(join(dir, rel), "utf8")) ? { pass: true, detail: what } : { pass: false, detail: `not found: ${what}` };
	} catch {
		return { pass: false, detail: `${rel} unreadable` };
	}
}

/** Pass when the app builds and stays on the kit AND the feature's hallmark is present anywhere under src/ (the
 *  grep is what tells "the feature was built" from "the app still compiles"; without it buildsAndOnKit passes on the
 *  untouched fixture). The grep is structural, not a judge: it names an element, API or the labels the task asked for. */
function builtFeature(re: RegExp, what: string): Task["oracle"] {
	return (dir) => {
		const build = buildsAndOnKit(dir);
		if (!build.pass) return build;
		const src = sh("bash", ["-c", `grep -rIl . src 2>/dev/null | xargs grep -lE ${JSON.stringify(re.source)} 2>/dev/null || true`], dir).out.trim();
		return src ? { pass: true, detail: `${what}; ${build.detail}`, lintViolations: 0 } : { pass: false, detail: `builds and on-kit, but ${what} is missing`, lintViolations: 0 };
	};
}

/** Keep-the-look oracle, offline floor: index.html's visible text and element structure are identical to the fixture
 *  (a redesign — the 2026-11-24 website failure — changes both), the smoke test passes, AND `cssDone(before, after)`
 *  confirms the asked-for refactor actually happened in styles.css (so a do-nothing run fails, not passes). The
 *  stronger form is a Playwright toHaveScreenshot against a committed baseline; see README ("A stronger oracle"). */
function keepLook(cssDone: (before: string, after: string) => boolean, what: string): Task["oracle"] {
	return (dir) => {
		let now = "";
		try {
			now = readFileSync(join(dir, "index.html"), "utf8");
		} catch {
			return { pass: false, detail: "index.html gone" };
		}
		const base = sh("git", ["show", "HEAD:index.html"], dir).out;
		const text = (h: string) => h.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		const tags = (h: string) => (h.replace(/<style[\s\S]*?<\/style>/gi, "").match(/<([a-z][\w-]*)/gi) ?? []).map((x) => x.toLowerCase()).join(",");
		if (text(base) !== text(now)) return { pass: false, detail: "the visible text of index.html changed" };
		if (tags(base) !== tags(now)) return { pass: false, detail: "the element structure of index.html changed" };
		const cssBefore = sh("git", ["show", "HEAD:styles.css"], dir).out;
		const cssAfter = (() => {
			try {
				return readFileSync(join(dir, "styles.css"), "utf8");
			} catch {
				return "";
			}
		})();
		if (!cssDone(cssBefore, cssAfter)) return { pass: false, detail: `look kept, but ${what} did not happen in styles.css` };
		// The website has no npm test script; its smoke test is a node:test file run directly.
		const smoke = existsSync(join(dir, "test")) ? sh("node", ["--test", "test/"], dir) : { ok: true, out: "" };
		return { pass: smoke.ok, detail: smoke.ok ? `look kept, ${what}, smoke green` : "look kept but smoke test failed" };
	};
}

const rootVars = (css: string) => (css.match(/^\s*--[\w-]+\s*:/gm) ?? []).length;
const rules = (css: string) => (css.match(/\{/g) ?? []).length;

const t = (id: string, size: Size, prompt: string, setup: Task["setup"], oracle: Task["oracle"]): Task => ({ id, size, prompt, setup, oracle });

export const TASKS: Task[] = [
	// Four one-line changes on the to-do app.
	t("o1-token-swap", "one-line", "In the todo app, make the Add button use the accent colour instead of the primary one.",
		(d) => todoApp(d), (d) => fileMatches(d, "src/app-main.ts", /\.add[\s\S]{0,120}var\(--accent\)|var\(--accent\)[\s\S]{0,120}\.add/, "the add button reads var(--accent)")),
	t("o2-copy-change", "one-line", "In the todo app, change the empty-state text from 'Nothing yet' to 'All clear'.",
		(d) => todoApp(d), (d) => fileMatches(d, "src/app-main.ts", /All clear/, "the empty state says All clear")),
	t("o3-ghost-button", "one-line", "In the todo app, give the Clear-done button the kit's ghost button style.",
		(d) => todoApp(d), (d) => fileMatches(d, "src/app-main.ts", /btn ghost/, "a ghost button exists")),
	t("o4-fix-test", "one-line", "The todo app's unit test for the counter is wrong: adding two items should leave the count at 2, not 1. Fix the test so it is right and passes.",
		(d) => {
			const dir = todoApp(d);
			// Break the counter assertion: the task is to fix it back to 2. Starts red, so the oracle (all tests green)
			// passes only once the agent has corrected it.
			const f = join(dir, "test", "todo.test.ts");
			writeFileSync(f, readFileSync(f, "utf8").replace("expect(counts(items).total).toBe(2)", "expect(counts(items).total).toBe(1)"));
			execFileSync("bash", ["-c", `cd '${dir}' && git -c user.name=bench -c user.email=bench@x commit -qam 'bug: wrong counter assertion'`], { stdio: "ignore" });
			return dir;
		}, buildsAndOnKit),

	// Four features on the to-do app.
	t("f1-settings-sheet", "feature", "Add a settings dialog to the todo app (the kit sheet) with one switch, 'Hide completed'. When it is on, completed items are not shown.",
		(d) => todoApp(d), builtFeature(/Hide completed/i, "a Hide-completed control exists")),
	t("f2-stat-tile", "feature", "Add a stat tile to the todo app showing how many items are done out of the total, using the kit's tk-stat.",
		(d) => todoApp(d), builtFeature(/<tk-stat/, "a tk-stat is rendered")),
	t("f3-persist", "feature", "Add a 'Keep across reloads' toggle to the todo app that saves the list to localStorage when on and clears it when off.",
		(d) => todoApp(d), builtFeature(/localStorage/, "localStorage is used")),
	t("f4-filter", "feature", "Add a segmented control to the todo app to filter items: All, Active, Done. The default is All.",
		(d) => todoApp(d), builtFeature(/Active[\s\S]{0,120}Done|class="seg"/, "an Active/Done filter exists")),

	// Two new apps from the template.
	t("n1-tip-split", "new-app", "Build a tip splitter on the template: enter a bill, a tip percent and a number of people, and show the tip, the total and the per-person amount. One screen.",
		(d) => copyTemplate(d), builtFeature(/per.?person/i, "a per-person amount is shown")),
	t("n2-length-convert", "new-app", "Build a length converter on the template: a number, a 'from' unit and a 'to' unit (mm, cm, m, km, in, ft, mi), showing the converted value live as you type.",
		(d) => copyTemplate(d), builtFeature(/\bkm\b[\s\S]{0,200}\bmi\b|\bmi\b[\s\S]{0,200}\bkm\b/, "the length units are present")),

	// Two "keep the look" refactors on the frozen website (CSS-only correct answers; the HTML stays byte-identical).
	t("k1-tokenise-css", "keep-the-look", "This is the website. Keep the look exactly. In styles.css only, pull the repeated colour values into CSS custom properties on :root and reference them. The page must render identically; don't touch the HTML.",
		(d) => copyWebsite(d), keepLook((before, after) => rootVars(after) > rootVars(before) && after.length > 0, "colours moved to :root custom properties")),
	t("k2-dedupe-css", "keep-the-look", "This is the website. Keep the look exactly. In styles.css only, merge the duplicated rules and drop any dead ones, so the page renders identically. Don't touch the HTML.",
		(d) => copyWebsite(d), keepLook((before, after) => after.length > 0 && rules(after) < rules(before), "duplicate rules merged (fewer rule blocks)")),
];

export function taskById(id: string): Task | undefined {
	return TASKS.find((x) => x.id === id);
}
