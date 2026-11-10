import { test } from "node:test";
import assert from "node:assert/strict";
import piGuard, { codeChanged, needsPr } from "../index.ts";
import { NUDGE_TYPE, PR_NUDGE_TYPE, REASONS, TODO_NUDGE_TYPE } from "../rules.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

function load(gitNeedsPr: (dir: string) => boolean = () => false) {
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	piGuard({ on: (event, handler) => void (handlers[event] = handler) }, gitNeedsPr);
	return handlers;
}

const stalled = [
	{ role: "user", content: "fix it" },
	{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "write" }] },
	{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
	{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
];

test("a stalled run is continued, though pi reports canContinue false before the nudge is added", () => {
	const r = load().agent_before_settle({ outcome: "completed", context: { canContinue: false, contextMessages: stalled } }, { cwd: "/" });
	assert.equal(r.continue, true);
	assert.equal(r.entries[0].customType, NUDGE_TYPE);
	assert.equal(r.entries[0].display, true);
});

test("an aborted run is never continued", () => {
	const r = load().agent_before_settle({ outcome: "aborted", context: { canContinue: false, contextMessages: stalled } }, { cwd: "/" });
	assert.equal(r, undefined);
});

test("tool_call returns the block for pi", () => {
	const r = load().tool_call({ toolName: "bash", input: { command: "cd ~/workspace/apps/keeb && gh run watch 1" } }, { cwd: "/" });
	assert.deepEqual(r, { block: true, reason: REASONS.ci });
});

test("a finished run with open to-dos on the branch gets the to-do nudge", () => {
	const finished = [
		{ role: "user", content: "fix it" },
		{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "edit" }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done. " + "x".repeat(400) }] },
	];
	const branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { nextId: 3, tasks: [{ id: 1, subject: "a", status: "completed" }, { id: 2, subject: "b", status: "in_progress" }] } } }];
	const ctx = { cwd: "/", sessionManager: { getBranch: () => branch } };
	const r = load().agent_before_settle({ outcome: "completed", context: { canContinue: false, contextMessages: finished } }, ctx);
	assert.equal(r.continue, true);
	assert.equal(r.entries[0].customType, TODO_NUDGE_TYPE);
	assert.match(r.entries[0].content, /#2 b \(in progress\)/);
	assert.equal(load().agent_before_settle({ outcome: "completed", context: { contextMessages: finished } }, { cwd: "/", sessionManager: { getBranch: () => [] } }), undefined);
});

test("a finished run that changed an app and left it unpublished gets the PR nudge", () => {
	const keeb = join(homedir(), "workspace", "apps", "keeb");
	const finished = [
		{ role: "user", content: "use the kit panel" },
		{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "edit", arguments: { path: `${keeb}/src/app-main.ts` } }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done. Next: open the PR with these commands. " + "x".repeat(400) }] },
	];
	const ctx = { cwd: "/", sessionManager: { getBranch: () => [] } };
	const r = load((d) => d === keeb).agent_before_settle({ outcome: "completed", context: { contextMessages: finished } }, ctx);
	assert.equal(r.entries[0].customType, PR_NUDGE_TYPE);
	assert.match(r.entries[0].content, /apps\/keeb/);
	assert.equal(load(() => false).agent_before_settle({ outcome: "completed", context: { contextMessages: finished } }, ctx), undefined);
});

test("needsPr: dirty tree, unpushed commits and never-pushed branches need a PR; a pushed clean branch does not", () => {
	const git = (dir: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });
	const remote = mkdtempSync(join(tmpdir(), "guard-remote-"));
	git(remote, "init", "-q", "--bare", "-b", "main");
	const dir = mkdtempSync(join(tmpdir(), "guard-app-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "remote", "add", "origin", remote);
	writeFileSync(join(dir, "a.txt"), "1");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "one");
	git(dir, "push", "-qu", "origin", "main");
	assert.equal(needsPr(dir), false);
	writeFileSync(join(dir, "a.txt"), "2");
	assert.equal(needsPr(dir), true);
	git(dir, "switch", "-qc", "feat");
	git(dir, "commit", "-qam", "two");
	assert.equal(needsPr(dir), true);
	git(dir, "push", "-qu", "origin", "feat");
	assert.equal(needsPr(dir), false);
	assert.equal(needsPr(join(dir, "missing")), false);
});

test("compaction leaves re-injected rule messages out of the summary input", () => {
	const rules = { role: "custom", customType: "i-have-adhd-rules", content: "ADHD MODE ACTIVE…", display: false };
	const task = { role: "user", content: "Make keeb teach like keybr" };
	const nudge = { role: "custom", customType: NUDGE_TYPE, content: "continue" };
	const preparation = { messagesToSummarize: [rules, task, nudge, { ...rules }], turnPrefixMessages: [{ ...rules }, task] };
	const r = load().session_before_compact({ preparation, reason: "threshold" }, { cwd: "/" });
	assert.equal(r, undefined, "pi's own summarizer still writes the summary");
	assert.deepEqual(preparation.messagesToSummarize, [task, nudge]);
	assert.deepEqual(preparation.turnPrefixMessages, [task]);
});

test("codeChanged: a branch that only touches docs, Markdown or CI skips the review", () => {
	const dir = mkdtempSync(join(tmpdir(), "guard-review-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
	git("init", "-q", "-b", "main");
	writeFileSync(join(dir, "README.md"), "a");
	git("add", "-A");
	git("commit", "-qm", "init");
	git("switch", "-qc", "docs");
	writeFileSync(join(dir, "README.md"), "b");
	assert.equal(codeChanged(dir), false, "uncommitted Markdown");
	git("commit", "-qam", "docs");
	assert.equal(codeChanged(dir), false, "committed Markdown");
	writeFileSync(join(dir, "app.ts"), "x");
	git("add", "app.ts");
	assert.equal(codeChanged(dir), true, "a staged code file");
	git("commit", "-qm", "code");
	assert.equal(codeChanged(dir), true, "a committed code file");
});
