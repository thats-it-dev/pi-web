import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ship } from "../scripts/lib/ship.ts";
import { openPr } from "../scripts/lib/pr.ts";
import type { Clock } from "../scripts/lib/wait.ts";
import { fakeRun, type Reply } from "./helpers.ts";

const SHA = "83a7f06aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROOT = "1111111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REPO = "thats-it-dev/foo";
const SUB = "foo-930.pages.dev";
const jobs = (conclusion: string) => ({ stdout: JSON.stringify({ jobs: [{ steps: [{ name: "Deploy to Cloudflare Pages", conclusion }] }] }) });
// gh run view answers either the jobs JSON or the failed-step log.
const view = (conclusion = "success", log = "") => (c: { args: string[] }) => (c.args.includes("--json") ? jobs(conclusion) : { stdout: log });

function appDir() {
	const d = mkdtempSync(join(tmpdir(), "thatsit-ship-"));
	writeFileSync(join(d, "app.config.json"), JSON.stringify({ name: "foo" }));
	return d;
}
// Virtual time: sleeping advances the clock instantly.
function clock(): Clock & { t: number } {
	const c = { t: 0, now: () => c.t, sleep: async (ms: number) => void (c.t += ms) };
	return c;
}
type T = Record<string, Reply | ((c: { args: string[] }) => Reply)>;

const shipTable = (over: T = {}): T => ({
	"git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
	"git status --porcelain": { stdout: "" },
	"git rev-list --max-parents=0 HEAD": { stdout: `${ROOT}\n` },
	"gh run list --repo thats-it-dev/foo --branch main --workflow deploy.yml --status success": { stdout: JSON.stringify([{ headSha: ROOT, databaseId: 1 }]) },
	"gh run view": view(),
	"npm run": {},
	"npm test": {},
	"git push origin main": {},
	"git rev-parse HEAD": { stdout: `${SHA}\n` },
	"gh run list --repo thats-it-dev/foo --commit": { stdout: JSON.stringify([{ databaseId: 42, status: "queued", conclusion: "" }]) },
	"gh run watch": {},
	"cf pages get": { stdout: JSON.stringify({ name: "foo", subdomain: SUB }) },
	...over,
});

test("ship happy path: exact calls in order, production URL", async () => {
	const f = fakeRun(shipTable());
	const urls: string[] = [];
	const r = await ship(appDir(), f.run, async (u) => (urls.push(u), 200), { clock: clock() });
	assert.deepEqual(r, { url: "https://foo.thatsit.app/", pending: false });
	assert.deepEqual(urls, ["https://foo.thatsit.app/"]);
	assert.deepEqual(f.lines().filter((l) => !l.startsWith("git rev-list") && !l.startsWith("git status")), [
		"git rev-parse --abbrev-ref HEAD",
		`gh run list --repo ${REPO} --branch main --workflow deploy.yml --status success --json headSha,databaseId`,
		"npm run typecheck",
		"npm test",
		"npm run e2e",
		"git push origin main",
		"git rev-parse HEAD",
		`gh run list --repo ${REPO} --commit ${SHA} --json databaseId,status,conclusion`,
		`gh run watch 42 --repo ${REPO} --exit-status`,
		`gh run view 42 --repo ${REPO} --json jobs`,
	]);
});

test("ship refuses off main", async () => {
	const f = fakeRun(shipTable({ "git rev-parse --abbrev-ref HEAD": { stdout: "feat\n" } }));
	await assert.rejects(ship(appDir(), f.run, async () => 200, { clock: clock() }), /main/);
	assert.ok(!f.lines().some((l) => l.startsWith("git push")));
});

test("ship refuses a dirty tree", async () => {
	const f = fakeRun(shipTable({ "git status --porcelain": { stdout: " M src/main.ts\n" } }));
	await assert.rejects(ship(appDir(), f.run, async () => 200, { clock: clock() }), /uncommitted/);
	assert.ok(!f.lines().some((l) => l.startsWith("git push")));
});

test("ship refuses when main already has a successful app deploy", async () => {
	const f = fakeRun(shipTable({
		"gh run list --repo thats-it-dev/foo --branch main --workflow deploy.yml --status success": { stdout: JSON.stringify([{ headSha: ROOT, databaseId: 1 }, { headSha: SHA, databaseId: 2 }]) },
	}));
	await assert.rejects(ship(appDir(), f.run, async () => 200, { clock: clock() }), /pull request|already shipped/i);
	assert.ok(!f.lines().some((l) => l.startsWith("git push") || l.startsWith("npm")));
});

test("ship may be retried after a red first deploy (only root commit succeeded)", async () => {
	const f = fakeRun(shipTable({ "gh run list --repo thats-it-dev/foo --branch main --workflow deploy.yml --status success": { stdout: "[]" } }));
	const r = await ship(appDir(), f.run, async () => 200, { clock: clock() });
	assert.equal(r.pending, false);
});

test("ship stops before pushing when a local check fails", async () => {
	const f = fakeRun(shipTable({ "npm test": { code: 1, stdout: "1 failing" } }));
	await assert.rejects(ship(appDir(), f.run, async () => 200, { clock: clock() }), /npm test/);
	assert.ok(!f.lines().some((l) => l.startsWith("git push")));
});

test("ship retries the run lookup until the run appears", async () => {
	let n = 0;
	const f = fakeRun(shipTable({
		"gh run list --repo thats-it-dev/foo --commit": () => ({ stdout: ++n < 3 ? "[]" : JSON.stringify([{ databaseId: 7 }]) }),
	}));
	await ship(appDir(), f.run, async () => 200, { clock: clock() });
	assert.ok(f.lines().includes(`gh run watch 7 --repo ${REPO} --exit-status`));
});

test("ship fails when no run ever appears", async () => {
	const f = fakeRun(shipTable({ "gh run list --repo thats-it-dev/foo --commit": { stdout: "[]" } }));
	await assert.rejects(ship(appDir(), f.run, async () => 200, { clock: clock() }), /no deploy run/i);
});

test("ship red deploy includes the log tail", async () => {
	const log = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
	const f = fakeRun(shipTable({
		"gh run watch": { code: 1 },
		"gh run view": view("failure", log),
	}));
	await assert.rejects(ship(appDir(), f.run, async () => 200, { clock: clock() }), (e: Error) => {
		assert.match(e.message, /line 60/);
		assert.match(e.message, /line 21/);
		assert.doesNotMatch(e.message, /line 20\b/);
		return true;
	});
	assert.ok(f.lines().includes(`gh run view 42 --repo ${REPO} --log-failed`));
});

test("ship domain never 200: pages.dev fallback with pending, within the timeout", async () => {
	const c = clock();
	const f = fakeRun(shipTable());
	const r = await ship(appDir(), f.run, async () => 404, { clock: c, domainTimeoutMs: 5000 });
	assert.deepEqual(r, { url: `https://${SUB}/`, pending: true });
	assert.ok(c.t <= 5000 + 3000);
});

test("ship domain turns 200 after a few tries", async () => {
	let n = 0;
	const r = await ship(appDir(), fakeRun(shipTable()).run, async () => (++n < 3 ? 0 : 200), { clock: clock() });
	assert.equal(r.pending, false);
});

// ---- pr ----

const comment = (sha: string, login = "github-actions[bot]") => ({
	user: { login },
	body: `<!-- thatsit-preview -->\nPreview: https://feat-x.${SUB}\n\nCommit ${sha}`,
});
const prTable = (over: T = {}): T => ({
	"git rev-parse --abbrev-ref HEAD": { stdout: "feat-x\n" },
	"git status --porcelain": { stdout: "" },
	"git fetch origin main": {},
	"git rev-list --count origin/main..HEAD": { stdout: "2\n" },
	"npm run": {},
	"npm test": {},
	"git push -u origin HEAD": {},
	"gh pr create": { stdout: `https://github.com/${REPO}/pull/5\n` },
	"git rev-parse HEAD": { stdout: `${SHA}\n` },
	"gh run list --repo thats-it-dev/foo --commit": { stdout: JSON.stringify([{ databaseId: 9 }]) },
	"gh run watch": {},
	"gh run view": view(),
	"gh pr view": { code: 1, stderr: "no pull requests found" },
	"gh api": { stdout: JSON.stringify([{ user: { login: "someone" }, body: "hi" }, comment("83a7f06")]) },
	...over,
});
const opts = { title: "Add x", body: "Does x" };

test("pr happy path: exact calls and preview URL", async () => {
	const f = fakeRun(prTable());
	const r = await openPr(appDir(), opts, f.run, { clock: clock() });
	assert.deepEqual(r, { pr: `https://github.com/${REPO}/pull/5`, preview: `https://feat-x.${SUB}` });
	assert.deepEqual(f.lines().filter((l) => !l.startsWith("git status") && !l.startsWith("git fetch")), [
		"git rev-parse --abbrev-ref HEAD",
		"git rev-list --count origin/main..HEAD",
		"npm run typecheck",
		"npm test",
		"npm run e2e",
		"git push -u origin HEAD",
		"gh pr view --json url",
		`gh pr create --repo ${REPO} --title Add x --body Does x`,
		"git rev-parse HEAD",
		`gh run list --repo ${REPO} --commit ${SHA} --json databaseId,status,conclusion`,
		`gh run watch 9 --repo ${REPO} --exit-status`,
		`gh run view 9 --repo ${REPO} --json jobs`,
		`gh api repos/${REPO}/issues/5/comments --paginate`,
	]);
});

test("pr refuses on main, dirty tree, and no commits ahead", async () => {
	for (const [over, re] of [
		[{ "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" } }, /main/],
		[{ "git status --porcelain": { stdout: "?? x\n" } }, /uncommitted/],
		[{ "git rev-list --count origin/main..HEAD": { stdout: "0\n" } }, /no commits/i],
	] as [T, RegExp][]) {
		const f = fakeRun(prTable(over));
		await assert.rejects(openPr(appDir(), opts, f.run, { clock: clock() }), re);
		assert.ok(!f.lines().some((l) => l.startsWith("git push")));
	}
});

test("pr red run: error carries the log tail, old preview is not returned", async () => {
	const f = fakeRun(prTable({
		"gh run watch": { code: 1 },
		"gh run view": view("failure", Array.from({ length: 50 }, (_, i) => `row ${i + 1}`).join("\n")),
	}));
	await assert.rejects(openPr(appDir(), opts, f.run, { clock: clock() }), (e: Error) => {
		assert.match(e.message, /row 50/);
		assert.doesNotMatch(e.message, /row 10\b/);
		assert.doesNotMatch(e.message, /Preview/);
		return true;
	});
	assert.ok(!f.lines().some((l) => l.startsWith("gh api")));
});

test("pr stale comment SHA counts as no preview and fails after the bounded retry", async () => {
	const c = clock();
	const f = fakeRun(prTable({ "gh api": { stdout: JSON.stringify([comment("0000000")]) } }));
	await assert.rejects(openPr(appDir(), opts, f.run, { clock: c }), /preview/i);
	assert.ok(c.t >= 60000 && c.t <= 70000);
	assert.ok(f.lines().filter((l) => l.startsWith("gh api")).length > 1);
});

test("pr picks up the comment once it is updated to the head SHA", async () => {
	let n = 0;
	const f = fakeRun(prTable({ "gh api": () => ({ stdout: JSON.stringify([comment(++n < 3 ? "0000000" : "83a7f06")]) }) }));
	const r = await openPr(appDir(), opts, f.run, { clock: clock() });
	assert.equal(r.preview, `https://feat-x.${SUB}`);
});

test("pr ignores a marker comment from a non-bot user and handles concatenated pages", async () => {
	const f = fakeRun(prTable({
		"gh api": { stdout: `${JSON.stringify([comment("83a7f06", "mallory")])}${JSON.stringify([comment("83a7f06")])}` },
	}));
	const r = await openPr(appDir(), opts, f.run, { clock: clock() });
	assert.equal(r.preview, `https://feat-x.${SUB}`);
});

test("ship: a green run whose deploy step was skipped fails with a plain reason", async () => {
	const f = fakeRun(shipTable({ "gh run view": view("skipped") }));
	await assert.rejects(ship(appDir(), f.run, async () => 200, { clock: clock() }), /deploy step was skipped.*Cloudflare secrets/);
});

test("ship: a skipped-deploy success on main does not count as already shipped", async () => {
	const f = fakeRun(shipTable({
		"gh run list --repo thats-it-dev/foo --branch main --workflow deploy.yml --status success": { stdout: JSON.stringify([{ headSha: SHA, databaseId: 2 }]) },
		"gh run view": view("skipped"),
	}));
	await assert.rejects(ship(appDir(), f.run, async () => 200, { clock: clock() }), /skipped/);
	assert.ok(f.lines().includes("git push origin main"));
});

test("pr: a skipped deploy step is an error, not 'no preview'", async () => {
	const f = fakeRun(prTable({ "gh run view": view("skipped") }));
	await assert.rejects(openPr(appDir(), opts, f.run, { clock: clock() }), /deploy step was skipped/);
	assert.ok(!f.lines().some((l) => l.startsWith("gh api")));
});

test("pr reuses an existing PR and only pushes", async () => {
	const f = fakeRun(prTable({ "gh pr view": { stdout: JSON.stringify({ url: `https://github.com/${REPO}/pull/5` }) } }));
	const r = await openPr(appDir(), opts, f.run, { clock: clock() });
	assert.equal(r.pr, `https://github.com/${REPO}/pull/5`);
	assert.ok(f.lines().includes("git push -u origin HEAD"));
	assert.ok(!f.lines().some((l) => l.startsWith("gh pr create")));
});

test("a stuck run watch times out with the run URL", async () => {
	const base = fakeRun(shipTable());
	const run: typeof base.run = async (cmd, args, o) => {
		if (cmd === "gh" && args[1] === "watch") return { code: 1, stdout: "", stderr: "timed out", timedOut: true };
		return base.run(cmd, args, o);
	};
	await assert.rejects(ship(appDir(), run, async () => 200, { clock: clock(), watchTimeoutMs: 60_000 }), /actions\/runs\/42/);
});
