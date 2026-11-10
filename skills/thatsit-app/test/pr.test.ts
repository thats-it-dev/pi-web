import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPr, waitPr } from "../scripts/lib/pr.ts";
import type { Clock } from "../scripts/lib/wait.ts";
import { fakeRun, type Reply } from "./helpers.ts";

const SHA = "83a7f06aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PR = "https://github.com/thats-it-dev/foo/pull/5";
type T = Record<string, Reply | ((c: { args: string[] }) => Reply)>;
const clock = (): Clock => ({ now: () => 0, sleep: async () => {} });
const appDir = () => {
	const d = mkdtempSync(join(tmpdir(), "thatsit-pr-"));
	writeFileSync(join(d, "app.config.json"), JSON.stringify({ name: "foo" }));
	return d;
};
const table = (over: T = {}): T => ({
	"git rev-parse --abbrev-ref HEAD": { stdout: "feat-x\n" },
	"git status --porcelain": { stdout: "" },
	"git fetch origin main": {},
	"git rev-list --count origin/main..HEAD": { stdout: "2\n" },
	"git push -u origin HEAD": {},
	"gh pr view": { code: 1, stderr: "no pull requests found" },
	"gh pr create": { stdout: `${PR}\n` },
	"git rev-parse HEAD": { stdout: `${SHA}\n` },
	...over,
});
const opts = { title: "Add x", body: "Does x" };

test("openPr pushes, opens the PR and returns without watching CI", async () => {
	const f = fakeRun(table());
	const r = await openPr(appDir(), opts, f.run, { clock: clock(), log: () => {} });
	assert.deepEqual(r, { pr: PR, number: 5 });
	assert.ok(f.lines().some((l) => l.startsWith("gh pr create")));
	assert.ok(!f.lines().some((l) => l.startsWith("gh run") || l.startsWith("gh api")));
});

test("openPr reuses an existing open PR", async () => {
	const f = fakeRun(table({ "gh pr view": { stdout: JSON.stringify({ url: PR, state: "OPEN", body: "x" }) } }));
	const r = await openPr(appDir(), opts, f.run, { clock: clock(), log: () => {} });
	assert.deepEqual(r, { pr: PR, number: 5 });
	assert.ok(f.lines().includes("git push -u origin HEAD"));
	assert.ok(!f.lines().some((l) => l.startsWith("gh pr create")));
});

test("waitPr fails with run pr first when the branch has no open PR", async () => {
	await assert.rejects(waitPr(appDir(), fakeRun(table()).run, { clock: clock() }), /no open PR for this branch; run pr first/);
});
