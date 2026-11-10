import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncTemplate } from "../scripts/lib/sync-template.ts";
import { fakeRun, type Reply } from "./helpers.ts";

const write = (root: string, files: Record<string, string>) => {
	for (const [f, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, f)), { recursive: true });
		writeFileSync(join(root, f), text);
	}
};

const TEMPLATE = {
	"AGENTS.md": "# Working on this app\n",
	"test/guardrails.test.ts": "// guardrails\n",
	".github/workflows/deploy.yml": "name: deploy\n",
	"scripts/gateway-url.ts": "// gateway\n",
	"knip.json": '{ "entry": [] }\n',
	"playwright.config.ts": 'export default {\n\tworkers: process.env.CI ? 2 : "50%",\n};\n',
	"package.json": JSON.stringify({
		name: "app-template",
		scripts: { test: "vitest run", "e2e:one": "playwright test --project=desktop", lint: "knip --no-progress", guardrails: "vitest run test/guardrails.test.ts && npm run lint", verify: "npm run typecheck && npm test && npm run lint && npm run e2e" },
		devDependencies: { knip: "5.88.1" },
	}),
};

function app(files: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "sync-app-"));
	write(dir, {
		"app.config.json": '{ "name": "keeb" }\n',
		"package.json": '{\n  "name": "touchtype",\n  "scripts": {\n    "test": "vitest run --mine"\n  }\n}\n',
		"package-lock.json": '{\n  "name": "touchtype",\n  "packages": {\n    "": { "name": "touchtype" }\n  }\n}\n',
		"playwright.config.ts": "export default {\n\tworkers: 1,\n};\n",
		"AGENTS.md": "old notes\n",
		...files,
	});
	return dir;
}

function runs(over: Record<string, Reply> = {}) {
	return fakeRun({
		"git status": { stdout: "" },
		"gh repo clone": (c) => (write(c.args[3], TEMPLATE), {}),
		npm: {},
		"npm run guardrails": { code: 1, stdout: "src/app-main.ts: 930 lines, 530 over" },
		...over,
	});
}

test("copies the template's files, scripts and knip, renames the package, then runs the guardrails", async () => {
	const dir = app();
	const f = runs();
	const r = await syncTemplate(dir, f.run);
	assert.deepEqual(r.changed, [...Object.keys(TEMPLATE).slice(0, 5), "package.json", "playwright.config.ts", "package-lock.json"]);
	for (const file of ["AGENTS.md", "test/guardrails.test.ts", ".github/workflows/deploy.yml", "scripts/gateway-url.ts", "knip.json"]) {
		assert.equal(readFileSync(join(dir, file), "utf8"), TEMPLATE[file as keyof typeof TEMPLATE], file);
	}
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	assert.equal(pkg.name, "keeb");
	assert.equal(pkg.scripts.test, "vitest run --mine", "an app's own scripts are kept");
	assert.equal(pkg.scripts.guardrails, "vitest run test/guardrails.test.ts && npm run lint");
	assert.equal(pkg.devDependencies.knip, "5.88.1");
	assert.match(readFileSync(join(dir, "package.json"), "utf8"), /^\{\n  "name"/, "indentation kept");
	assert.equal(JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")).packages[""].name, "keeb");
	assert.match(readFileSync(join(dir, "playwright.config.ts"), "utf8"), /\tworkers: process\.env\.CI \? 2 : "50%",/);
	assert.deepEqual(r.guardrails, { ok: false, output: "src/app-main.ts: 930 lines, 530 over" });
	const l = f.lines();
	assert.ok(l.indexOf("npm install --no-audit --no-fund") < l.indexOf("npm run guardrails"));
	assert.ok(l[1].startsWith("gh repo clone thats-it-dev/app-template ") && l[1].endsWith(" -- --depth 1"));
	assert.ok(!existsSync(f.calls[1].args[3]), "the template clone is removed");
});

test("an app's own knip.json is kept, and a synced app changes nothing", async () => {
	const dir = app({ "knip.json": '{ "entry": ["src/extra.ts"] }\n' });
	await syncTemplate(dir, runs().run);
	assert.equal(readFileSync(join(dir, "knip.json"), "utf8"), '{ "entry": ["src/extra.ts"] }\n');
	const f = runs({ "npm run guardrails": { stdout: "ok" } });
	const again = await syncTemplate(dir, f.run);
	assert.deepEqual(again, { changed: [], notes: [], guardrails: { ok: true, output: "ok" } });
	assert.ok(!f.lines().some((x) => x.startsWith("npm install")), "nothing to install");
});

test("a Playwright config without a workers line is reported, not rewritten", async () => {
	const dir = app({ "playwright.config.ts": "export default {};\n" });
	const r = await syncTemplate(dir, runs().run);
	assert.equal(readFileSync(join(dir, "playwright.config.ts"), "utf8"), "export default {};\n");
	assert.match(r.notes[0], /no workers line/);
});

test("refuses a dirty tree or a folder that is not an app", async () => {
	await assert.rejects(syncTemplate(app(), runs({ "git status": { stdout: " M src/a.ts\n" } }).run), /uncommitted changes/);
	await assert.rejects(syncTemplate(mkdtempSync(join(tmpdir(), "x-")), runs().run), /not an app/);
});
