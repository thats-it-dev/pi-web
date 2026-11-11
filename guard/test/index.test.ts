import { test } from "node:test";
import assert from "node:assert/strict";
import piGuard, { codeChanged, needsPr, scopeReview, upToDate } from "../index.ts";
import { NUDGE_TYPE, PR_NUDGE_TYPE, REASONS, reviewedSinceUser, reviewMark, TODO_NUDGE_TYPE } from "../rules.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

function load(gitNeedsPr: (dir: string) => boolean = () => false, env: Record<string, string | undefined> = {}) {
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	piGuard({ on: (event, handler) => void (handlers[event] = handler) }, gitNeedsPr, env);
	return handlers;
}

test("inside a subagent child the guard blocks but never nudges", () => {
	const h = load(() => true, { PI_SUBAGENT_CHILD: "1" });
	assert.equal(h.agent_before_settle({ outcome: "completed", context: { canContinue: false, contextMessages: stalled } }, { cwd: "/" }), undefined);
	assert.deepEqual(h.tool_call({ toolName: "bash", input: { command: "cd ~/workspace/apps/keeb && git push" } }, { cwd: "/" }), { block: true, reason: REASONS.push });
});

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

// --- scoped reviews, against a real git repo under a throwaway home ---

function appRepo() {
	const home = mkdtempSync(join(tmpdir(), "guard-home-"));
	const dir = join(home, "workspace", "apps", "keeb");
	mkdirSync(join(dir, "src"), { recursive: true });
	const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { verify: "true" } }));
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "one");
	git("switch", "-qc", "feat");
	return { home, dir, git };
}
const msg = (role: string, rest: Record<string, unknown>) => ({ type: "message", message: { role, ...rest } });
const verified = (dir: string) => [
	msg("assistant", { content: [{ type: "toolCall", id: "v", name: "bash", arguments: { command: `cd ${dir} && npm run verify` } }] }),
	msg("toolResult", { toolCallId: "v", isError: false, content: [] }),
];

test("scopeReview: blocks before verify, then writes the diff since main and rewrites the call", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	writeFileSync(join(dir, "src", "new.ts"), "export const b = 1;\n");
	writeFileSync(join(dir, "package-lock.json"), "{}");
	const edited = [msg("assistant", { content: [{ type: "toolCall", id: "e", name: "edit", arguments: { path: join(dir, "src", "a.ts") } }] })];
	const input: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb: daily goal", toolBudget: { hard: 500 }, context: "fork" };
	assert.deepEqual(scopeReview({ ...input }, edited, home, home), { block: true, reason: REASONS.reviewUnverified });
	const r = scopeReview(input, [...edited, ...verified(dir)], home, home) as { dir: string; snap: string };
	assert.equal(r.dir, dir);
	assert.match(r.snap, /^[0-9a-f]{40}$/);
	assert.deepEqual(input.toolBudget, { soft: 12, hard: 20, block: "*" });
	assert.equal(input.async, undefined, "the guard no longer forces a sync review");
	assert.equal(input.cwd, dir);
	assert.equal(input.context, undefined);
	assert.match(String(input.task), /- src\/a\.ts \(\+1 -1\)/);
	assert.match(String(input.task), /- src\/new\.ts \(\+1 -0\)/, "untracked files are in the diff");
	assert.doesNotMatch(String(input.task), /package-lock/);
	assert.match(String(input.task), /daily goal$/);
	const diff = readFileSync("/tmp/keeb-review.diff", "utf8");
	assert.match(diff, /\+export const a = 2;/);
	assert.doesNotMatch(diff, /package-lock/);
});

test("scopeReview: the next review covers only what changed since the last one; nothing new is blocked", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	const first: Record<string, unknown> = { agent: "reviewer", task: "Review /tmp/keeb-review.diff" };
	const { snap } = scopeReview(first, verified(dir), home, home) as { snap: string };
	const after = [...verified(dir), msg("toolResult", { toolCallId: "r", isError: false, content: [{ type: "text", text: reviewMark(dir, snap) }] })];
	assert.equal(upToDate(dir, after), true);
	assert.deepEqual(scopeReview({ agent: "reviewer", task: "Review /tmp/keeb-review.diff" }, after, home, home), { block: true, reason: REASONS.reviewNothing });
	writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
	assert.equal(upToDate(dir, after), false);
	const second: Record<string, unknown> = { agent: "reviewer", task: "Review /tmp/keeb-review.diff" };
	scopeReview(second, after, home, home);
	assert.match(String(second.task), /- src\/b\.ts/);
	assert.doesNotMatch(String(second.task), /- src\/a\.ts/, "a.ts was already reviewed");
	assert.match(String(second.task), /already reviewed/);
});

test("scopeReview: a reviewer inside a workflow on an app is blocked; non-app reviews pass untouched", () => {
	const { home } = appRepo();
	assert.deepEqual(scopeReview({ chain: [{ agent: "reviewer", task: "review ~/workspace/apps/keeb" }] }, [], home, home), { block: true, reason: REASONS.reviewWorkflow });
	const plan: Record<string, unknown> = { agent: "reviewer", task: "Review this plan" };
	assert.equal(scopeReview(plan, [], home, home), undefined);
	assert.equal(plan.task, "Review this plan");
});

test("tool_result marks a scoped review so the PR gate sees it", () => {
	const h = load();
	const r = h.tool_result({ toolCallId: "unknown", content: [{ type: "text", text: "x" }], isError: false }, { cwd: "/" });
	assert.equal(r, undefined, "only calls the guard scoped");
});

test("tool_result gives the model a cancelled questionnaire's partial answers", () => {
	const h = load();
	const details = { cancelled: true, answers: [{ questionIndex: 0, question: "Q1", kind: "option", answer: "A" }] };
	const r = h.tool_result({ toolCallId: "q", toolName: "ask_user_question", input: { questions: [{ question: "Q1" }, { question: "Q2" }] }, content: [{ type: "text", text: "User declined to answer questions" }], details, isError: false }, { cwd: "/" });
	assert.match(r.content[0].text, /answered 1 of 2.*"Q1"="A"/);
	assert.equal(r.details, details);
	const plain = h.tool_result({ toolCallId: "q2", toolName: "ask_user_question", input: {}, content: [], details: { cancelled: true, answers: [] }, isError: false }, { cwd: "/" });
	assert.equal(plain, undefined);
});

test("an async scoped review keeps async and gets a pending mark; a sync one gets the finished mark", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n");
	const h = load(() => false, { HOME: home });
	const ctx = { cwd: dir, sessionManager: { getBranch: () => verified(dir) } };
	const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");
	const input: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb", async: true };
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "r1", input }, ctx), undefined);
	assert.equal(input.async, true);
	const r1 = h.tool_result({ toolCallId: "r1", toolName: "subagent", content: [{ type: "text", text: "Async: reviewer [0bdd2a04-7e76-4cca-8c02-1ad3fb71d86b]" }], isError: false }, ctx);
	assert.match(text(r1), /\[pi-guard\] review pending \S+ at [0-9a-f]{40} run 0bdd2a04-7e76-4cca-8c02-1ad3fb71d86b/);
	const sync: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb" };
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "r2", input: sync }, ctx), undefined);
	assert.equal(sync.async, undefined);
	const r2 = h.tool_result({ toolCallId: "r2", toolName: "subagent", content: [{ type: "text", text: "## Review\nnothing" }], isError: false }, ctx);
	assert.match(text(r2), /\[pi-guard\] reviewed \S+ at [0-9a-f]{40}/);
	assert.doesNotMatch(text(r2), /review pending/);
});

test("scopeReview keeps a resident model and strips any other, and a failed lookup strips", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 4;\n");
	const branch = verified(dir);
	const task = "Review keeb at ~/workspace/apps/keeb";
	const resident = () => ["qwen3.8-27b-pi", "qwen3.6-35b-a3b-sglang"];
	const keep: Record<string, unknown> = { agent: "reviewer", task, model: "spark/qwen3.8-27b-pi" };
	assert.ok(!("block" in (scopeReview(keep, branch, home, home, resident) ?? {})));
	assert.equal(keep.model, "spark/qwen3.8-27b-pi");
	const strip: Record<string, unknown> = { agent: "reviewer", task, model: "spark/qwen3.8-flash-next" };
	scopeReview(strip, branch, home, home, resident);
	assert.equal(strip.model, undefined);
	const down: Record<string, unknown> = { agent: "reviewer", task, model: "spark/qwen3.8-27b-pi" };
	assert.ok(!("block" in (scopeReview(down, branch, home, home, () => { throw new Error("ECONNREFUSED"); }) ?? {})));
	assert.equal(down.model, undefined);
});

test("an async scoped review whose launch result has no run id gets a pending mark that never counts", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 5;\n");
	const h = load(() => false, { HOME: home });
	const ctx = { cwd: dir, sessionManager: { getBranch: () => verified(dir) } };
	const input: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb", async: true };
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "r9", input }, ctx), undefined);
	const r = h.tool_result({ toolCallId: "r9", toolName: "subagent", content: [{ type: "text", text: "Launched in the background." }], isError: false }, ctx);
	const text = r.content.map((c: any) => c.text ?? "").join("\n");
	assert.match(text, /\[pi-guard\] review pending \S+ at [0-9a-f]{40} run unknown/);
	assert.doesNotMatch(text, /\[pi-guard\] reviewed /);
	assert.equal(reviewedSinceUser([{ type: "message", message: { role: "user", content: "go" } }, { type: "message", message: { role: "toolResult", content: r.content } }], () => "complete"), false, "an unknown run never counts, whatever the resolver says");
});
