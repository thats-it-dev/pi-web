import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../scripts/lib/new-app.ts";
import { fakeRun, type Reply } from "./helpers.ts";

const SUB = "foo-930.pages.dev";
const base = { name: "foo", title: "Foo App", description: "Does foo", color: "#FFAA00", resume: false };
const tmp = () => mkdtempSync(join(tmpdir(), "thatsit-"));

function table(over: Record<string, Reply | ((c: { args: string[] }) => Reply)> = {}) {
	return {
		"gh repo view": { code: 1, stderr: "Could not resolve to a Repository" },
		"cf pages get": { code: 1, stderr: "[8000007] Project not found." },
		"cf dns records list": { stdout: "[]" },
		"gh repo create": {},
		"gh repo clone": (c: { args: string[] }) => {
			mkdirSync(join(c.args[3], ".git"), { recursive: true });
			writeFileSync(join(c.args[3], "app.config.json"), "{}");
			return {};
		},
		npm: {},
		git: {},
		"cf pages create": { stdout: JSON.stringify({ name: "foo", subdomain: SUB }) },
		"cf pages domains get": { code: 1, stderr: "not found" },
		"cf pages domains create": {},
		"cf dns records create": {},
		...over,
	};
}

test("runs the seven steps in order with exact arguments", async () => {
	const appsDir = tmp();
	const dir = join(appsDir, "foo");
	const f = fakeRun(table());
	const r = await newApp({ ...base, appsDir }, f.run);
	assert.deepEqual(r, { dir, pagesSubdomain: SUB });
	const l = f.lines();
	const mut = l.filter((x) => !/^(gh repo view|cf pages get|cf dns records list|cf pages domains get|git (rev-parse|remote|log))/.test(x));
	assert.deepEqual(mut, [
		"gh repo create thats-it-dev/foo --public --template thats-it-dev/app-template",
		`gh repo clone thats-it-dev/foo ${dir}`,
		"npm ci",
		"npm run icons",
		"git add -A",
		"git commit -m Configure foo",
		"cf pages create --name foo --production-branch main",
		"cf pages domains create foo --name foo.thatsit.app",
		`cf dns records create -z thatsit.app --body {"type":"CNAME","name":"foo","content":"${SUB}","proxied":true}`,
	]);
	assert.ok(l.indexOf("gh repo view thats-it-dev/foo --json name") < l.indexOf("gh repo create thats-it-dev/foo --public --template thats-it-dev/app-template"));
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "app.config.json"), "utf8")), {
		name: "foo", title: "Foo App", description: "Does foo", color: "#FFAA00",
	});
	for (const c of f.calls.filter((c) => c.cmd === "npm" || c.cmd === "git")) assert.equal(c.cwd, dir);
});

test("a taken name refuses before any create", async () => {
	const f = fakeRun(table({ "gh repo view": { stdout: '{"name":"foo"}' } }));
	await assert.rejects(newApp({ ...base, appsDir: tmp() }, f.run), /GitHub repo exists/);
	assert.ok(!f.lines().some((x) => x.includes("create")));
});

test("invalid color is rejected", async () => {
	await assert.rejects(newApp({ ...base, color: "red", appsDir: tmp() }, fakeRun(table()).run), /color/);
});

test("creates appsDir when missing", async () => {
	const appsDir = join(tmp(), "nested", "apps");
	await newApp({ ...base, appsDir }, fakeRun(table()).run);
	assert.ok(existsSync(join(appsDir, "foo", "app.config.json")));
});

test("failing step stops the run and shows stderr", async () => {
	const f = fakeRun(table({ "cf pages create": { code: 1, stderr: "quota exceeded" } }));
	await assert.rejects(newApp({ ...base, appsDir: tmp() }, f.run), /cf pages create.*quota exceeded/s);
	assert.ok(!f.lines().some((x) => x.startsWith("cf pages domains create")));
	assert.ok(!f.lines().some((x) => x.startsWith("cf dns records create")));
});

function resumeTable(appsDir: string, over = {}) {
	const dir = join(appsDir, "foo");
	mkdirSync(join(dir, ".git"), { recursive: true });
	writeFileSync(join(dir, "app.config.json"), JSON.stringify({ name: "foo", title: "Foo App", description: "Does foo", color: "#FFAA00" }));
	return table({
		"gh repo view": { stdout: '{"name":"foo"}' },
		"git remote get-url": { stdout: "https://github.com/thats-it-dev/foo.git\n" },
		"git log": { stdout: "Configure foo\n" },
		"cf pages get": { stdout: JSON.stringify({ name: "foo", subdomain: SUB }) },
		"cf pages domains get": { stdout: '{"name":"foo.thatsit.app"}' },
		"cf dns records list": { stdout: JSON.stringify([{ name: "foo.thatsit.app", type: "CNAME", content: SUB }]) },
		...over,
	});
}

test("resume with everything present makes no create calls", async () => {
	const appsDir = tmp();
	const f = fakeRun(resumeTable(appsDir));
	const r = await newApp({ ...base, resume: true, appsDir }, f.run);
	assert.equal(r.pagesSubdomain, SUB);
	assert.deepEqual(f.lines().filter((x) => /create|clone|commit|npm/.test(x)), []);
});

test("resume after repo created but pages failed finishes the rest", async () => {
	const appsDir = tmp();
	const f = fakeRun(resumeTable(appsDir, {
		"cf pages get": { code: 1, stderr: "[8000007] Project not found." },
		"cf pages domains get": { code: 1 },
		"cf dns records list": { stdout: "[]" },
	}));
	await newApp({ ...base, resume: true, appsDir }, f.run);
	const l = f.lines();
	assert.ok(!l.some((x) => x.startsWith("gh repo create") || x.startsWith("gh repo clone") || x.includes("commit")));
	assert.ok(l.includes("cf pages create --name foo --production-branch main"));
	assert.ok(l.some((x) => x.startsWith("cf pages domains create")));
	assert.ok(l.some((x) => x.startsWith("cf dns records create")));
});

test("resume with repo but no checkout clones and configures", async () => {
	const appsDir = tmp();
	const f = fakeRun(table({ "gh repo view": { stdout: '{"name":"foo"}' } }));
	await newApp({ ...base, resume: true, appsDir }, f.run);
	const l = f.lines();
	assert.ok(!l.some((x) => x.startsWith("gh repo create")));
	assert.ok(l.some((x) => x.startsWith("gh repo clone")));
	assert.ok(l.includes("git commit -m Configure foo"));
});

test("resume with existing CNAME pointing elsewhere fails without overwriting", async () => {
	const appsDir = tmp();
	const f = fakeRun(resumeTable(appsDir, {
		"cf dns records list": { stdout: JSON.stringify([{ name: "foo.thatsit.app", type: "CNAME", content: "evil.example.com" }]) },
	}));
	await assert.rejects(newApp({ ...base, resume: true, appsDir }, f.run), /evil\.example\.com/);
	assert.ok(!f.lines().some((x) => x.startsWith("cf dns records create")));
});

test("resume with a checkout of a different repo fails", async () => {
	const appsDir = tmp();
	const f = fakeRun(resumeTable(appsDir, { "git remote get-url": { stdout: "https://github.com/someone/else.git\n" } }));
	await assert.rejects(newApp({ ...base, resume: true, appsDir }, f.run), /not a clone/);
});

test("fresh run refuses an existing checkout dir before any create call", async () => {
	const appsDir = tmp();
	mkdirSync(join(appsDir, "foo"));
	const f = fakeRun(table());
	await assert.rejects(newApp({ ...base, appsDir }, f.run), /already exists/);
	assert.ok(!f.lines().some((x) => x.includes("create")));
});
