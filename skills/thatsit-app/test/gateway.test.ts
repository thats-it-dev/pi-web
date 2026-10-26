import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayCheckout, gatewayPr, gatewayRegister, gatewayPreviewUrl } from "../scripts/lib/gateway.ts";
import { openPr } from "../scripts/lib/pr.ts";
import type { Clock } from "../scripts/lib/wait.ts";
import { fakeRun, type Reply } from "./helpers.ts";

const GW = "thats-it-dev/spark-gateway";
const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const PREVIEW = "https://spark-713a.tail9274fa.ts.net:9512";
type T = Record<string, Reply | ((c: { args: string[] }) => Reply)>;

function clock(): Clock & { t: number } {
	const c = { t: 0, now: () => c.t, sleep: async (ms: number) => void (c.t += ms) };
	return c;
}
const tmp = () => mkdtempSync(join(tmpdir(), "thatsit-gw-"));
// An apps dir holding a spark-gateway checkout with the given apps.json.
function gwDir(apps: unknown[] = []) {
	const appsDir = tmp();
	const dir = join(appsDir, "spark-gateway");
	mkdirSync(join(dir, ".git"), { recursive: true });
	writeFileSync(join(dir, "apps.json"), `${JSON.stringify(apps)}\n`);
	return { appsDir, dir };
}

// ---- gateway-checkout ----

const checkoutTable = (over: T = {}): T => ({
	"gh api user": { stdout: JSON.stringify({ id: 42, login: "octo", name: "Octo Cat" }) },
	"gh repo clone": (c) => (mkdirSync(join(c.args[3], ".git"), { recursive: true }), {}),
	"git remote get-url origin": { stdout: `https://github.com/${GW}.git\n` },
	"git status --porcelain": { stdout: "" },
	git: {},
	"npm ci": {},
	...over,
});

test("gateway-checkout clones when missing, sets a clone-local identity, updates main", async () => {
	const appsDir = tmp();
	const dir = join(appsDir, "spark-gateway");
	const f = fakeRun(checkoutTable());
	assert.deepEqual(await gatewayCheckout(appsDir, f.run), { dir });
	assert.deepEqual(f.lines().filter((l) => !l.startsWith("gh api user") && !l.startsWith("git status")), [
		`gh repo clone ${GW} ${dir}`,
		"git config user.name Octo Cat",
		"git config user.email 42+octo@users.noreply.github.com",
		"git switch main",
		"git pull --ff-only",
		"npm ci",
	]);
	for (const c of f.calls.filter((c) => c.cmd === "git" || c.cmd === "npm")) assert.equal(c.cwd, dir);
});

test("gateway-checkout reuses a clone, refuses a foreign one and a dirty tree", async () => {
	const { appsDir } = gwDir();
	const ok = fakeRun(checkoutTable());
	await gatewayCheckout(appsDir, ok.run);
	assert.ok(!ok.lines().some((l) => l.startsWith("gh repo clone")));
	const foreign = fakeRun(checkoutTable({ "git remote get-url origin": { stdout: "https://github.com/x/y.git\n" } }));
	await assert.rejects(gatewayCheckout(appsDir, foreign.run), /not a clone of thats-it-dev\/spark-gateway/);
	const dirty = fakeRun(checkoutTable({ "git status --porcelain": { stdout: " M apps.json\n" } }));
	await assert.rejects(gatewayCheckout(appsDir, dirty.run), /uncommitted/);
	assert.ok(!dirty.lines().includes("git switch main"));
});

// ---- gateway-register ----

const registerTable = (over: T = {}): T => ({
	"git remote get-url origin": { stdout: `https://github.com/${GW}.git\n` },
	"git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
	"git status --porcelain": { stdout: "" },
	"cf pages get tips-abc": { stdout: JSON.stringify({ name: "tips-abc", subdomain: "tips-abc.pages.dev" }) },
	"cf pages get tips": { stdout: JSON.stringify({ name: "tips", subdomain: "tips-2bb.pages.dev" }) },
	git: {},
	...over,
});

test("gateway-register derives pagesSubdomain from cf pages get and commits on register-<app>", async () => {
	const { appsDir, dir } = gwDir([{ name: "other", pagesSubdomain: "other-1" }]);
	const f = fakeRun(registerTable());
	const r = await gatewayRegister(appsDir, "tips-abc", f.run);
	assert.deepEqual(r, { dir, branch: "register-tips-abc", name: "tips-abc", pagesSubdomain: "tips-abc" });
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "apps.json"), "utf8")), [
		{ name: "other", pagesSubdomain: "other-1" },
		{ name: "tips-abc", pagesSubdomain: "tips-abc" },
	]);
	const l = f.lines();
	assert.ok(l.includes("git switch -c register-tips-abc"));
	assert.ok(l.indexOf("git switch -c register-tips-abc") < l.indexOf("git add apps.json"));
	assert.ok(l.includes("git commit -m Register tips-abc"));
});

test("gateway-register strips a suffixed subdomain and stays on an existing branch", async () => {
	const { appsDir, dir } = gwDir();
	const f = fakeRun(registerTable({ "git rev-parse --abbrev-ref HEAD": { stdout: "tips-routes\n" } }));
	const r = await gatewayRegister(appsDir, "tips", f.run);
	assert.equal(r.pagesSubdomain, "tips-2bb");
	assert.equal(r.branch, "tips-routes");
	assert.ok(!f.lines().some((l) => l.startsWith("git switch")));
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "apps.json"), "utf8")), [{ name: "tips", pagesSubdomain: "tips-2bb" }]);
});

test("gateway-register refuses a duplicate", async () => {
	const { appsDir, dir } = gwDir([{ name: "tips-abc", pagesSubdomain: "tips-abc" }]);
	const f = fakeRun(registerTable());
	await assert.rejects(gatewayRegister(appsDir, "tips-abc", f.run), /already registered/);
	assert.ok(!f.lines().some((l) => l.startsWith("git commit") || l.startsWith("git switch")));
	assert.equal(JSON.parse(readFileSync(join(dir, "apps.json"), "utf8")).length, 1);
});

test("gateway-register refuses an app without a Pages project, a bad name, and a missing checkout", async () => {
	const { appsDir } = gwDir();
	const f = fakeRun(registerTable({ "cf pages get tips-abc": { code: 1, stderr: "[8000007] Project not found." } }));
	await assert.rejects(gatewayRegister(appsDir, "tips-abc", f.run), /no Pages project/);
	assert.ok(!f.lines().some((l) => l.startsWith("git commit")));
	await assert.rejects(gatewayRegister(appsDir, "Bad_Name", fakeRun(registerTable()).run), /invalid name/);
	await assert.rejects(gatewayRegister(tmp(), "tips", fakeRun(registerTable()).run), /gateway-checkout/);
});

// ---- gateway-pr ----

const status = (state: string) => ({ stdout: JSON.stringify({ statuses: [{ context: "ci/other", state: "success" }, { context: "spark-preview", state, description: "x" }] }) });
const comments = (...bodies: string[]) => ({ stdout: JSON.stringify(bodies.map((body) => ({ user: { login: "octo" }, body }))) });
const okComment = (sha = SHA) => `<!-- spark-preview -->\nPreview gateway: ${PREVIEW}\n\nHead: ${sha}`;
const tail = Array.from({ length: 20 }, (_, i) => `out ${i + 1}`).join("\n");
const failComment = `<!-- spark-preview -->\nPreview of ${SHA} failed: tests failed.\n\nLast 20 lines:\n\n\`\`\`\n${tail}\n\`\`\``;

const gwPrTable = (over: T = {}): T => ({
	"git remote get-url origin": { stdout: `https://github.com/${GW}.git\n` },
	"git rev-parse --abbrev-ref HEAD": { stdout: "register-tips\n" },
	"git status --porcelain": { stdout: "" },
	"git fetch origin main": {},
	"git rev-list --count origin/main..HEAD": { stdout: "1\n" },
	"git diff --name-only --no-renames origin/main...HEAD": { stdout: "apps.json\napps/tips/routes.ts\napps/tips/routes.test.ts\n" },
	"npm run typecheck": {},
	"npm test": {},
	"gh pr view": { code: 1, stderr: "no pull requests found" },
	"git push -u origin HEAD": {},
	"gh pr create": { stdout: `https://github.com/${GW}/pull/12\n` },
	"git rev-parse HEAD": { stdout: `${SHA}\n` },
	"gh run list": { stdout: JSON.stringify([{ databaseId: 77 }]) },
	"gh run watch": {},
	"gh run view": { stdout: "" },
	[`gh api repos/${GW}/commits/${SHA}/status`]: status("success"),
	[`gh api repos/${GW}/issues/12/comments`]: comments("hello", okComment()),
	...over,
});
const gwOpts = { title: "Register tips", body: "Adds tips" };

test("gateway-pr: test workflow, then spark-preview success maps to the preview URL", async () => {
	const { dir } = gwDir();
	const f = fakeRun(gwPrTable());
	const r = await gatewayPr(dir, gwOpts, f.run, { clock: clock() });
	assert.deepEqual(r, { pr: `https://github.com/${GW}/pull/12`, number: 12, preview: PREVIEW });
	const l = f.lines();
	assert.ok(l.includes("npm run typecheck") && l.includes("npm test"));
	assert.ok(!l.includes("npm run e2e"));
	assert.ok(l.includes(`gh pr create --repo ${GW} --title Register tips --body Adds tips`));
	assert.ok(l.includes(`gh run list --repo ${GW} --commit ${SHA} --workflow test.yml --json databaseId,status,conclusion`));
	assert.ok(l.indexOf(`gh run watch 77 --repo ${GW} --exit-status`) < l.indexOf(`gh api repos/${GW}/commits/${SHA}/status`));
	assert.ok(!l.some((x) => x.startsWith("gh pr merge")));
});

test("gateway-pr: spark-preview failure exits with the comment's test output tail", async () => {
	const { dir } = gwDir();
	const f = fakeRun(gwPrTable({
		[`gh api repos/${GW}/commits/${SHA}/status`]: status("failure"),
		[`gh api repos/${GW}/issues/12/comments`]: comments(failComment),
	}));
	await assert.rejects(gatewayPr(dir, gwOpts, f.run, { clock: clock() }), (e: Error) => {
		assert.match(e.message, /spark preview .*failed/);
		assert.match(e.message, /tests failed/);
		assert.match(e.message, /out 1\b/);
		assert.match(e.message, /out 20/);
		assert.doesNotMatch(e.message, /https:\/\/spark/);
		return true;
	});
});

test("gateway-pr: waits through pending and a stale comment until the head sha is named", async () => {
	const { dir } = gwDir();
	let s = 0;
	let c = 0;
	const f = fakeRun(gwPrTable({
		[`gh api repos/${GW}/commits/${SHA}/status`]: () => (++s < 3 ? (s === 1 ? { stdout: JSON.stringify({ statuses: [] }) } : status("pending")) : status("success")),
		[`gh api repos/${GW}/issues/12/comments`]: () => comments(++c < 3 ? okComment("0".repeat(40)) : okComment()),
	}));
	const r = await gatewayPr(dir, gwOpts, f.run, { clock: clock() });
	assert.equal(r.preview, PREVIEW);
});

test("gateway-pr: a No preview comment exits 1 with that message", async () => {
	const { dir } = gwDir();
	const f = fakeRun(gwPrTable({
		"gh pr create": { stdout: `https://github.com/${GW}/pull/512\n` },
		[`gh api repos/${GW}/commits/${SHA}/status`]: { stdout: JSON.stringify({ statuses: [] }) },
		[`gh api repos/${GW}/issues/512/comments`]: comments("<!-- spark-preview -->\nNo preview: PR numbers above 499 have no preview port."),
	}));
	await assert.rejects(gatewayPr(dir, gwOpts, f.run, { clock: clock() }), /No preview: PR numbers above 499/);
});

test("gateway-pr: a red test workflow fails before waiting for the spark", async () => {
	const { dir } = gwDir();
	const f = fakeRun(gwPrTable({ "gh run watch": { code: 1 }, "gh run view": { stdout: "boom line" } }));
	await assert.rejects(gatewayPr(dir, gwOpts, f.run, { clock: clock() }), /test run 77 failed.*\n[\s\S]*boom line/);
	assert.ok(!f.lines().some((l) => l.includes("/status")));
});

test("gateway-pr: gives up after 20 minutes without a spark-preview result", async () => {
	const { dir } = gwDir();
	const c = clock();
	const f = fakeRun(gwPrTable({ [`gh api repos/${GW}/commits/${SHA}/status`]: status("pending") }));
	await assert.rejects(gatewayPr(dir, gwOpts, f.run, { clock: c }), /20 min/);
	assert.ok(c.t >= 20 * 60_000 && c.t <= 21 * 60_000);
});

test("gateway-pr refuses main, a dirty tree, changes outside apps/, and a non-gateway checkout", async () => {
	for (const [over, re] of [
		[{ "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" } }, /main/],
		[{ "git status --porcelain": { stdout: " M src/x.ts\n" } }, /uncommitted/],
		[{ "git diff --name-only --no-renames origin/main...HEAD": { stdout: "apps/tips/routes.ts\nsrc/server.ts\n" } }, /src\/server\.ts/],
		[{ "git diff --name-only --no-renames origin/main...HEAD": { stdout: "apps/README.md\n" } }, /apps\/README\.md/],
		[{ "git remote get-url origin": { stdout: "https://github.com/thats-it-dev/tips.git\n" } }, /spark-gateway/],
	] as [T, RegExp][]) {
		const { dir } = gwDir();
		const f = fakeRun(gwPrTable(over));
		await assert.rejects(gatewayPr(dir, gwOpts, f.run, { clock: clock() }), re);
		assert.ok(!f.lines().some((l) => l.startsWith("git push")));
	}
});

test("gateway-pr reuses an existing OPEN PR", async () => {
	const { dir } = gwDir();
	const f = fakeRun(gwPrTable({ "gh pr view": { stdout: JSON.stringify({ url: `https://github.com/${GW}/pull/12`, state: "OPEN", body: "x" }) } }));
	const r = await gatewayPr(dir, gwOpts, f.run, { clock: clock() });
	assert.equal(r.number, 12);
	assert.ok(!f.lines().some((l) => l.startsWith("gh pr create")));
});

test("gatewayPreviewUrl is 9500+N", () => {
	assert.equal(gatewayPreviewUrl(12), PREVIEW);
});

// ---- pr --gateway-pr ----

const SUB = "foo-930.pages.dev";
function appDir(gateway = true, files: { client?: boolean; workflow?: string } = {}) {
	const d = tmp();
	writeFileSync(join(d, "app.config.json"), JSON.stringify({ name: "foo", gateway }));
	mkdirSync(join(d, "src"));
	if (files.client !== false) writeFileSync(join(d, "src", "gateway.ts"), "export {};\n");
	mkdirSync(join(d, ".github", "workflows"), { recursive: true });
	writeFileSync(join(d, ".github", "workflows", "deploy.yml"), files.workflow ?? "run: GATEWAY_URL=$(node scripts/gateway-url.ts)\n");
	return d;
}
const appComment = (gw: boolean) => `<!-- thatsit-preview -->\nPreview: https://feat-x.${SUB}\n\nCommit ${SHA.slice(0, 7)}${gw ? `\n\nGateway preview: ${PREVIEW}` : ""}`;
const appPrTable = (over: T = {}): T => ({
	"git rev-parse --abbrev-ref HEAD": { stdout: "feat-x\n" },
	"git status --porcelain": { stdout: "" },
	"git fetch origin main": {},
	"git rev-list --count origin/main..HEAD": { stdout: "2\n" },
	"npm run": {},
	"npm test": {},
	"git push -u origin HEAD": {},
	"gh pr view": { code: 1, stderr: "no pull requests found" },
	"gh pr create": { stdout: "https://github.com/thats-it-dev/foo/pull/5\n" },
	"gh pr edit": {},
	"git rev-parse HEAD": { stdout: `${SHA}\n` },
	"gh run list": { stdout: JSON.stringify([{ databaseId: 9 }]) },
	"gh run watch": {},
	"gh run view": { stdout: JSON.stringify({ jobs: [{ steps: [{ name: "Deploy to Cloudflare Pages", conclusion: "success" }] }] }) },
	"gh api": { stdout: JSON.stringify([{ user: { login: "github-actions[bot]" }, body: appComment(true) }]) },
	...over,
});

test("pr --gateway-pr 12 puts the Gateway line in the body and returns the gateway preview", async () => {
	const f = fakeRun(appPrTable());
	const r = await openPr(appDir(), { title: "Use gateway", body: "Reads models", gatewayPr: 12 }, f.run, { clock: clock() });
	assert.deepEqual(r, { pr: "https://github.com/thats-it-dev/foo/pull/5", preview: `https://feat-x.${SUB}`, gatewayPreview: PREVIEW });
	const create = f.calls.find((c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "create")!;
	const body = create.args[create.args.indexOf("--body") + 1];
	assert.match(body, /^Reads models\n\nGateway: thats-it-dev\/spark-gateway#12$/);
});

test("pr --gateway-pr on a reused PR edits the body before pushing", async () => {
	const f = fakeRun(appPrTable({ "gh pr view": { stdout: JSON.stringify({ url: "https://github.com/thats-it-dev/foo/pull/5", state: "OPEN", body: "Old body" }) } }));
	await openPr(appDir(), { title: "t", body: "b", gatewayPr: 12 }, f.run, { clock: clock() });
	const l = f.lines();
	const edit = l.findIndex((x) => x.startsWith("gh pr edit 5 --repo thats-it-dev/foo --body Old body\n\nGateway: thats-it-dev/spark-gateway#12"));
	assert.ok(edit >= 0, l.join("\n"));
	assert.ok(edit < l.indexOf("git push -u origin HEAD"));
});

test("pr --gateway-pr needs \"gateway\": true in app.config.json", async () => {
	const f = fakeRun(appPrTable());
	await assert.rejects(openPr(appDir(false), { title: "t", body: "b", gatewayPr: 12 }, f.run, { clock: clock() }), /"gateway": true/);
	assert.ok(!f.lines().some((l) => l.startsWith("git push")));
});

test("pr --gateway-pr refuses an app that predates gateway support, before pushing", async () => {
	for (const files of [{ client: false }, { workflow: "run: npm test\n" }]) {
		const f = fakeRun(appPrTable());
		await assert.rejects(
			openPr(appDir(true, files), { title: "t", body: "b", gatewayPr: 12 }, f.run, { clock: clock() }),
			/^Error: foo predates gateway support; tell Michael \(it needs the current template's gateway files\)$/,
		);
		assert.ok(!f.lines().some((l) => l.startsWith("git push")));
	}
});

test("gateway-pr: a failure status without a comment for the head fails after a minute with the status description", async () => {
	const { dir } = gwDir();
	const c = clock();
	const f = fakeRun(gwPrTable({
		[`gh api repos/${GW}/commits/${SHA}/status`]: { stdout: JSON.stringify({ statuses: [{ context: "spark-preview", state: "failure", description: "health check failed" }] }) },
		[`gh api repos/${GW}/issues/12/comments`]: comments(okComment("0".repeat(40))),
	}));
	await assert.rejects(gatewayPr(dir, gwOpts, f.run, { clock: c }), /failed \(health check failed\)/);
	assert.ok(c.t >= 60_000 && c.t < 2 * 60_000);
});

test("pr --gateway-pr fails when the app preview was not deployed with the Gateway line", async () => {
	const f = fakeRun(appPrTable({
		"gh pr view": { stdout: JSON.stringify({ url: "https://github.com/thats-it-dev/foo/pull/5", state: "OPEN", body: "Old body" }) },
		"gh api": { stdout: JSON.stringify([{ user: { login: "github-actions[bot]" }, body: appComment(false) }]) },
	}));
	const dir = appDir();
	await assert.rejects(openPr(dir, { title: "t", body: "b", gatewayPr: 12 }, f.run, { clock: clock() }), (e: Error) => {
		assert.match(e.message, /not using gateway preview #12/);
		assert.ok(e.message.includes(`cd ${dir} && git commit --allow-empty -m "Use gateway preview #12"`), e.message);
		return true;
	});
});

// git reports a rename as the new path only unless --no-renames; a real repo proves the guard sees both sides.
test("gateway-pr diff guard sees a src/ rename and a src/ deletion", async () => {
	const { realRun } = await import("../scripts/lib/run.ts");
	const { execFileSync } = await import("node:child_process");
	const repo = tmp();
	const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "pipe" });
	g("init", "-q", "-b", "main");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src", "server.ts"), "export const a = 1;\n".repeat(20));
	writeFileSync(join(repo, "src", "other.ts"), "export const b = 2;\n");
	g("add", "-A");
	g("commit", "-qm", "base");
	g("update-ref", "refs/remotes/origin/main", "HEAD");
	g("switch", "-qc", "x");
	mkdirSync(join(repo, "apps", "tips"), { recursive: true });
	g("mv", "src/server.ts", "apps/tips/routes.ts");
	g("rm", "-q", "src/other.ts");
	g("commit", "-qm", "sneak");
	const out = (await realRun("git", ["diff", "--name-only", "--no-renames", "origin/main...HEAD"], { cwd: repo })).stdout;
	const f = fakeRun(gwPrTable({ "git diff --name-only --no-renames origin/main...HEAD": { stdout: out } }));
	const { dir } = gwDir();
	await assert.rejects(gatewayPr(dir, gwOpts, f.run, { clock: clock() }), (e: Error) => {
		assert.match(e.message, /src\/server\.ts/);
		assert.match(e.message, /src\/other\.ts/);
		return true;
	});
	assert.ok(!f.lines().some((l) => l.startsWith("git push")));
});
