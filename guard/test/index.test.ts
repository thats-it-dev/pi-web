import { test } from "node:test";
import assert from "node:assert/strict";
import piGuard, { codeChanged, mainBranch, onTrunk, repoRoot, docsChanged, mergedBranch, needsPr, scopeReview, screenUpToDate, snapshot, switchToMain, uiChanged, upToDate } from "../index.ts";
import { KIT_PATTERNS_MARK, previewNote, MERGE_NUDGE_TYPE, NUDGE_TYPE, PR_NUDGE_TYPE, REASONS, reviewBlockedMark, reviewedSinceUser, reviewMark, reviewPendingMark, REVIEW_UNSCOPED, screenMark, TODO_NUDGE_TYPE } from "../rules.ts";
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

const chatEnv = { PI_WEB_SESSION_TYPE: "chat" };

test("a chat session gets no stall, to-do or PR nudge, but still the merge nudge", () => {
	const settle = (messages: unknown[], ctx: unknown = { cwd: "/", sessionManager: { getBranch: () => [] } }, gitNeedsPr: (d: string) => boolean = () => false) =>
		load(gitNeedsPr, chatEnv).agent_before_settle({ outcome: "completed", context: { canContinue: false, contextMessages: messages } }, ctx);
	assert.equal(settle(stalled), undefined, "no stall nudge");
	const keeb = join(homedir(), "workspace", "apps", "keeb");
	const finished = [
		{ role: "user", content: "fix it" },
		{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "edit", arguments: { path: `${keeb}/src/app-main.ts` } }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done. Next: open the PR with these commands. " + "x".repeat(400) }] },
	];
	const branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { nextId: 3, tasks: [{ id: 2, subject: "b", status: "in_progress" }] } } }];
	assert.equal(settle(finished, { cwd: "/", sessionManager: { getBranch: () => branch } }), undefined, "no to-do nudge");
	assert.equal(settle(finished, { cwd: "/", sessionManager: { getBranch: () => [] } }, (d) => d === keeb), undefined, "no PR nudge");
	const handed = [{ role: "user", content: "ship it" }, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Run this:\n\n```\ngh pr merge 2 --merge\n```" }] }];
	const r = settle(handed);
	assert.equal(r.continue, true);
	assert.equal(r.entries[0].customType, MERGE_NUDGE_TYPE);
});

test("a chat session is still blocked from pushing and merging", () => {
	const h = load(() => false, chatEnv);
	assert.deepEqual(h.tool_call({ toolName: "bash", input: { command: "cd ~/workspace/apps/keeb && git push" } }, { cwd: "/" }), { block: true, reason: REASONS.push });
	assert.deepEqual(h.tool_call({ toolName: "bash", input: { command: "gh pr merge 3" } }, { cwd: "/" }), { block: true, reason: REASONS.merge });
});

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
// The orchestrator looked at the screen as the working tree is now (the mark a screenshot command's result gets).
const looked = (dir: string) => [msg("toolResult", { toolCallId: "s", isError: false, content: [{ type: "text", text: screenMark(dir, snapshot(dir)) }] })];
const ready = (dir: string) => [...verified(dir), ...looked(dir)];

test("scopeReview: blocks before verify, then writes the diff since main and rewrites the call", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	writeFileSync(join(dir, "src", "new.ts"), "export const b = 1;\n");
	writeFileSync(join(dir, "package-lock.json"), "{}");
	const edited = [msg("assistant", { content: [{ type: "toolCall", id: "e", name: "edit", arguments: { path: join(dir, "src", "a.ts") } }] })];
	const input: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb: daily goal", toolBudget: { hard: 500 }, context: "fork" };
	assert.deepEqual(scopeReview({ ...input }, edited, home, home), { block: true, reason: REASONS.reviewUnverified });
	const r = scopeReview(input, [...edited, ...ready(dir)], home, home) as { dir: string; snap: string };
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
	const { snap } = scopeReview(first, ready(dir), home, home) as { snap: string };
	const after = [...ready(dir), msg("toolResult", { toolCallId: "r", isError: false, content: [{ type: "text", text: reviewMark(dir, snap) }] })];
	assert.equal(upToDate(dir, after), true);
	assert.deepEqual(scopeReview({ agent: "reviewer", task: "Review /tmp/keeb-review.diff" }, after, home, home), { block: true, reason: REASONS.reviewNothing });
	writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
	assert.equal(upToDate(dir, after), false);
	const second: Record<string, unknown> = { agent: "reviewer", task: "Review /tmp/keeb-review.diff" };
	scopeReview(second, [...after, ...looked(dir)], home, home);
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

test("a reviewer call is scoped by its own cwd when the task names no app, and a relative diff path resolves against it", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n");
	// keeb 2026-11-16 00:51: cwd=<app>, task with `.superpowers/sdd/.../review-x..y.diff`, session cwd = home.
	const input: Record<string, unknown> = { agent: "reviewer", async: true, cwd: dir, task: "PR-gate review.\n**Diff file:** .superpowers/sdd/2026-11-16-keeb-layers/review-0aa56db..9cca2a7.diff" };
	const r = scopeReview(input, [msg("user", { content: "make it so" }), ...ready(dir)], home, home) as { dir: string; snap: string };
	assert.equal(r.dir, dir);
	assert.equal(input.cwd, dir);
	assert.match(String(input.task), /^\[pi-guard\]|review/i);
	assert.match(String(input.task), /\[Michael's messages on this branch, verbatim[^\]]*\]\nmake it so\n/, "the reviewer gets Michael's words, not a summary");
	const tilde: Record<string, unknown> = { agent: "reviewer", cwd: "~/workspace/apps/keeb", task: "Review the branch" };
	assert.equal((scopeReview(tilde, ready(dir), home, home) as { dir: string }).dir, dir, "a ~ cwd expands");
	assert.equal(scopeReview({ agent: "reviewer", cwd: home, task: "Review the plan" }, ready(dir), home, home), undefined, "a cwd outside apps scopes nothing");
});

test("a reviewer launch the guard could not scope gets a note saying it will not count", () => {
	const { home } = appRepo();
	const h = load(() => false, { HOME: home });
	const ctx = { cwd: home, sessionManager: { getBranch: () => [] } };
	const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "u1", input: { agent: "reviewer", task: "Review the plan in docs/" } }, ctx), undefined);
	const r = h.tool_result({ toolCallId: "u1", toolName: "subagent", content: [{ type: "text", text: "Async: reviewer [0bdd2a04-7e76-4cca-8c02-1ad3fb71d86b]" }], isError: false }, ctx);
	assert.match(text(r), /Async: reviewer/);
	assert.ok(text(r).endsWith(REVIEW_UNSCOPED));
	assert.equal(h.tool_result({ toolCallId: "u1", toolName: "subagent", content: [{ type: "text", text: "again" }], isError: false }, ctx), undefined, "the note goes on once");
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "w1", input: { agent: "worker", task: "build it" } }, ctx), undefined);
	assert.equal(h.tool_result({ toolCallId: "w1", toolName: "subagent", content: [{ type: "text", text: "ok" }], isError: false }, ctx), undefined, "workers get no note");
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
	const ctx = { cwd: dir, sessionManager: { getBranch: () => ready(dir) } };
	const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");
	const input: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb", async: true };
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "r1", input }, ctx), undefined);
	assert.equal(input.async, true);
	const r1 = h.tool_result({ toolCallId: "r1", toolName: "subagent", content: [{ type: "text", text: "Async: reviewer [0bdd2a04-7e76-4cca-8c02-1ad3fb71d86b]" }], isError: false }, ctx);
	assert.match(text(r1), /\[pi-guard\] review pending \S+ at [0-9a-f]{40} run 0bdd2a04-7e76-4cca-8c02-1ad3fb71d86b/);
	const sync: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb" };
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "r2", input: sync }, ctx), undefined);
	assert.equal(sync.async, undefined);
	const r2 = h.tool_result({ toolCallId: "r2", toolName: "subagent", content: [{ type: "text", text: "## Review\n- Checked: a.ts\n- Merge verdict: OK" }], isError: false }, ctx);
	assert.match(text(r2), /\[pi-guard\] reviewed \S+ at [0-9a-f]{40}/);
	assert.doesNotMatch(text(r2), /review pending/);
});

test("scopeReview keeps a resident model, replaces an unloaded one with a loaded model, and a failed lookup strips", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 4;\n");
	const branch = ready(dir);
	const task = "Review keeb at ~/workspace/apps/keeb";
	const resident = () => ["qwen3.8-27b-pi", "qwen3.6-35b-a3b-sglang"];
	const keep: Record<string, unknown> = { agent: "reviewer", task, model: "spark/qwen3.8-27b-pi" };
	assert.ok(!("block" in (scopeReview(keep, branch, home, home, resident) ?? {})));
	assert.equal(keep.model, "spark/qwen3.8-27b-pi");
	const strip: Record<string, unknown> = { agent: "reviewer", task, model: "spark/qwen3.8-flash-next" };
	scopeReview(strip, branch, home, home, resident);
	assert.equal(strip.model, "spark/qwen3.8-27b-pi", "no configured model in this home: the first loaded one");
	const down: Record<string, unknown> = { agent: "reviewer", task, model: "spark/qwen3.8-27b-pi" };
	assert.ok(!("block" in (scopeReview(down, branch, home, home, () => { throw new Error("ECONNREFUSED"); }) ?? {})));
	assert.equal(down.model, undefined);
});

test("an async scoped review whose launch result has no run id gets a pending mark that never counts", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 5;\n");
	const h = load(() => false, { HOME: home });
	const ctx = { cwd: dir, sessionManager: { getBranch: () => ready(dir) } };
	const input: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb", async: true };
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "r9", input }, ctx), undefined);
	const r = h.tool_result({ toolCallId: "r9", toolName: "subagent", content: [{ type: "text", text: "Launched in the background." }], isError: false }, ctx);
	const text = r.content.map((c: any) => c.text ?? "").join("\n");
	assert.match(text, /\[pi-guard\] review pending \S+ at [0-9a-f]{40} run unknown/);
	assert.doesNotMatch(text, /\[pi-guard\] reviewed /);
	assert.equal(reviewedSinceUser([{ type: "message", message: { role: "user", content: "go" } }, { type: "message", message: { role: "toolResult", content: r.content } }], () => "complete"), false, "an unknown run never counts, whatever the resolver says");
});

test("with the agent pair in settings.json, the parent session is the orchestrator and may not edit app code; a child may", () => {
	const home = mkdtempSync(join(tmpdir(), "home-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ defaultModel: "spark/pair-auto", subagents: { defaultModel: "spark/qwen3.6-35b-a3b-sglang" } }));
	const edit = { toolName: "edit", input: { path: join(home, "workspace", "apps", "keeb", "src", "a.ts"), edits: [] } };
	assert.deepEqual(load(() => false, { HOME: home }).tool_call(edit, { cwd: home }), { block: true, reason: REASONS.orchestrator });
	assert.equal(load(() => false, { HOME: home, PI_SUBAGENT_CHILD: "1" }).tool_call(edit, { cwd: home }), undefined);
	writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ defaultModel: "spark/flash-auto" }));
	assert.equal(load(() => false, { HOME: home }).tool_call(edit, { cwd: home }), undefined);
});

test("a sync scoped review that returns without a verdict gets a note instead of the reviewed mark", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 6;\n");
	const h = load(() => false, { HOME: home });
	const ctx = { cwd: dir, sessionManager: { getBranch: () => ready(dir) } };
	const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");
	const input: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb" };
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "r3", input }, ctx), undefined);
	const r = h.tool_result({ toolCallId: "r3", toolName: "subagent", content: [{ type: "text", text: "Now let me check one more thing — how `tk-stat` renders its `.value`:\nMission: cf39d943 (completed)" }], isError: false }, ctx);
	assert.doesNotMatch(text(r), /\[pi-guard\] reviewed /);
	assert.doesNotMatch(text(r), /review pending/);
	assert.match(text(r), /\[pi-guard\] review ended without a verdict/);
	assert.equal(reviewedSinceUser([{ type: "message", message: { role: "user", content: "go" } }, { type: "message", message: { role: "toolResult", content: r.content } }]), false);
	// The same call again is not "nothing to review": the app is still unreviewed at this state.
	const again: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb" };
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "r4", input: again }, { ...ctx, sessionManager: { getBranch: () => [...ready(dir), { type: "message", message: { role: "toolResult", toolCallId: "r3", content: r.content } }] } }), undefined);
	const ok = h.tool_result({ toolCallId: "r4", toolName: "subagent", content: [{ type: "text", text: "## Review\n- Checked: a.ts\n- Merge verdict: OK" }], isError: false }, ctx);
	assert.match(text(ok), /\[pi-guard\] reviewed \S+ at [0-9a-f]{40}/);
});

// --- the screen gate, against a real git repo ---

test("uiChanged: committed, staged, unstaged and untracked UI files count; docs, tests and briefs do not", () => {
	const { dir, git } = appRepo();
	assert.equal(uiChanged(dir), false, "nothing changed yet");
	mkdirSync(join(dir, "docs"), { recursive: true });
	writeFileSync(join(dir, "docs", "spec.md"), "spec");
	mkdirSync(join(dir, ".superpowers", "sdd"), { recursive: true });
	writeFileSync(join(dir, ".superpowers", "sdd", "brief.md"), "brief");
	mkdirSync(join(dir, "test"), { recursive: true });
	writeFileSync(join(dir, "test", "a.test.ts"), "test");
	assert.equal(uiChanged(dir), false, "docs, briefs and tests");
	writeFileSync(join(dir, "src", "new.ts"), "export const b = 1;\n");
	assert.equal(uiChanged(dir), true, "an untracked UI file");
	git("add", "-A");
	git("commit", "-qm", "ui");
	assert.equal(uiChanged(dir), true, "a committed UI file");
});

test("screenUpToDate: the last picture must show the UI files as they are; other edits don't age it", () => {
	const { dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	assert.equal(screenUpToDate(dir, []), false, "never looked");
	const branch = looked(dir);
	assert.equal(screenUpToDate(dir, branch), true);
	mkdirSync(join(dir, "docs"), { recursive: true });
	writeFileSync(join(dir, "docs", "spec.md"), "spec");
	assert.equal(screenUpToDate(dir, branch), true, "a docs edit after the look");
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n");
	assert.equal(screenUpToDate(dir, branch), false, "a UI edit after the look");
	assert.equal(screenUpToDate(dir, [...branch, ...looked(dir)]), true, "looked again");
});

test("scopeReview: a UI change that was not looked at is blocked before any diff is written", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	const input: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb" };
	assert.deepEqual(scopeReview({ ...input }, verified(dir), home, home), { block: true, reason: REASONS.screen });
	assert.ok(!("block" in (scopeReview({ ...input }, ready(dir), home, home) ?? {})));
	// A change outside the UI files needs no picture.
	const { home: h2, dir: d2 } = appRepo();
	mkdirSync(join(d2, "test"), { recursive: true });
	writeFileSync(join(d2, "test", "a.test.ts"), "x");
	assert.ok(!("block" in (scopeReview({ ...input }, verified(d2), h2, h2) ?? {})));
});

test("a screenshot command's result gets the picture and the mark, and the gate then opens", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	const png = join(dir, "test-results", "screens", "phone-dark.png");
	mkdirSync(join(dir, "test-results", "screens"), { recursive: true });
	writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	mkdirSync(join(dir, "docs"), { recursive: true });
	writeFileSync(join(dir, "docs", "spec.md"), "# Spec\n- Nut is drawn on the right edge.\n");
	const h = load(() => false, { HOME: home });
	// Michael's picture on the branch comes back beside the screen, with his words, so the two are compared.
	const reference = { type: "image", data: Buffer.from("ref").toString("base64"), mimeType: "image/png" };
	const entries: unknown[] = [msg("user", { content: [{ type: "text", text: "Make it look like this" }, reference] }), ...verified(dir)];
	const ctx = { cwd: home, sessionManager: { getBranch: () => entries } };
	const command = `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts screenshot ${dir}`;
	assert.equal(h.tool_call({ toolName: "bash", toolCallId: "s1", input: { command } }, ctx), undefined, "the command itself is never blocked");
	const result = { toolName: "bash", toolCallId: "s1", input: { command }, isError: false, content: [{ type: "text", text: `RESULT {"ok":true,"file":"${png}","width":780,"height":1688,"issues":[]}` }] };
	const r = h.tool_call({ toolName: "bash", toolCallId: "pr", input: { command: `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ${dir} --title t --body b` } }, ctx);
	assert.deepEqual(r, { block: true, reason: REASONS.screen }, "no picture yet");
	const out = h.tool_result(result, ctx);
	// src/a.ts was already changed when the session first touched the app: the inherited-changes note rides along.
	assert.equal(out.content.length, 8, "result, screen, spec, picture label, picture, comparison, mark, inherited note");
	assert.match(out.content[7].text, /^\[pi-guard\] inherited changes .*\/keeb: src\/a\.ts\n/);
	assert.deepEqual(out.content[1], { type: "image", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), mimeType: "image/png" });
	assert.match(out.content[2].text, /^docs\/spec\.md, what the screen must match:\n\n# Spec\n- Nut is drawn on the right edge\./);
	assert.equal(out.content[3].text, 'Michael sent this picture with: "Make it look like this"');
	assert.deepEqual(out.content[4], reference);
	assert.match(out.content[5].text, /^Compare the screen with docs\/spec\.md, Michael's pictures above .* and write down what differs/);
	assert.match(out.content[6].text, /^\[pi-guard\] screen seen /);
	entries.push(msg("toolResult", { toolCallId: "s1", isError: false, content: out.content }));
	assert.equal(screenUpToDate(dir, entries), true);
	const r2 = h.tool_call({ toolName: "bash", toolCallId: "pr2", input: { command: `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ${dir} --title t --body b` } }, ctx);
	assert.equal(r2?.block, true, "looked; the review gate is next");
	assert.match(String(r2?.reason), /^Blocked: run the reviewer before opening the PR[\s\S]*\nNo reviewer call since Michael's last message was scoped to this repo/);
	// A failed command or one that reported no picture leaves no mark.
	h.tool_call({ toolName: "bash", toolCallId: "s2", input: { command } }, ctx);
	assert.equal(h.tool_result({ ...result, toolCallId: "s2", content: [{ type: "text", text: 'RESULT {"ok":false,"reason":"no vite"}' }] }, ctx), undefined);
	h.tool_call({ toolName: "bash", toolCallId: "s3", input: { command } }, ctx);
	assert.equal(h.tool_result({ ...result, toolCallId: "s3", isError: true }, ctx), undefined);
	// A picture that is gone gets a note, not a mark.
	h.tool_call({ toolName: "bash", toolCallId: "s4", input: { command } }, ctx);
	const gone = h.tool_result({ ...result, toolCallId: "s4", content: [{ type: "text", text: `RESULT {"ok":true,"file":"${dir}/nope.png"}` }] }, ctx);
	assert.match(gone.content[1].text, /could not be read/);
});

test("a resume on a worker whose stopped run carried a follow-up gets the withdrawal note in its message", () => {
	const h = load();
	const L = "4b06b6d8-bc17-4715-ac06-eae2787245ca";
	const X = "96ab932e-2cba-4b01-ac45-7d286b918a4b";
	const entries = [
		msg("assistant", { content: [{ type: "toolCall", id: "c1", name: "subagent", arguments: { agent: "worker", task: "Build it" } }] }),
		msg("toolResult", { toolCallId: "c1", isError: false, content: [{ type: "text", text: `Async: worker [${L}]` }] }),
		msg("assistant", { content: [{ type: "toolCall", id: "c2", name: "subagent", arguments: { action: "resume", id: L, message: "Remove the dialog border." } }] }),
		msg("toolResult", { toolCallId: "c2", isError: false, content: [{ type: "text", text: `Revived async subagent from ${L}.\nRevived run: ${X}` }] }),
		msg("assistant", { content: [{ type: "toolCall", id: "c3", name: "subagent", arguments: { action: "stop", id: X } }] }),
		msg("toolResult", { toolCallId: "c3", isError: false, content: [{ type: "text", text: "Stop requested." }] }),
	];
	const input = { action: "resume", id: L, message: "Swap the icon for the lucide gear." };
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "c4", input }, { cwd: homedir(), sessionManager: { getBranch: () => entries } }), undefined);
	assert.match(input.message, /^\[pi-guard\] Michael stopped your previous run before it finished, which withdraws the follow-up it carried: "Remove the dialog border\."\. .*\n\nSwap the icon for the lucide gear\.$/s);
});

test("every provider request is digested into the prompt log with the system prompt's section sizes", () => {
	const home = mkdtempSync(join(tmpdir(), "guard-home-"));
	const h = load(() => false, { HOME: home });
	h.before_agent_start({ systemPromptOptions: { sections: { "personal-wiki": "a".repeat(1137), persona: null, extra: ["x"] } } }, {});
	assert.equal(h.before_provider_request({ payload: { model: "qwen", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] } }, {}), undefined);
	h.before_provider_request({ payload: { nothing: true } }, {});
	const lines = readFileSync(join(home, ".pi", "agent", "tmp", "pi-guard-prompts.jsonl"), "utf8").trim().split("\n");
	assert.equal(lines.length, 1, "a payload without messages is not logged");
	const entry = JSON.parse(lines[0]);
	assert.equal(entry.model, "qwen");
	assert.equal(entry.msgs.length, 1);
	assert.equal(entry.child, false);
	assert.deepEqual(entry.sections, { "personal-wiki": 1137, persona: 0, extra: -1 });
	assert.match(entry.t, /^\d{4}-\d{2}-\d{2}T/);
});

const gitIn = (dir: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe", encoding: "utf8" }).trim();

// A clean checkout on branch `feat` with a remote whose main it tracks.
function repoOnFeat(dir: string): void {
	const remote = mkdtempSync(join(tmpdir(), "guard-remote-"));
	execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
	gitIn(dir, "init", "-b", "main");
	writeFileSync(join(dir, "a.txt"), "a\n");
	gitIn(dir, "add", "-A");
	gitIn(dir, "commit", "-m", "one");
	gitIn(dir, "remote", "add", "origin", remote);
	gitIn(dir, "push", "-u", "origin", "main");
	gitIn(dir, "switch", "-c", "feat");
	writeFileSync(join(dir, "b.txt"), "b\n");
	gitIn(dir, "add", "-A");
	gitIn(dir, "commit", "-m", "two");
}

test("mergedBranch: a clean checkout on a branch GitHub says is merged; dirty trees, main and open PRs are left alone", () => {
	const dir = mkdtempSync(join(tmpdir(), "guard-merged-"));
	repoOnFeat(dir);
	assert.equal(mergedBranch(dir, () => "MERGED"), "feat");
	assert.equal(mergedBranch(dir, () => undefined), undefined, "PR still open");
	assert.equal(mergedBranch(dir, () => { throw new Error("offline"); }), undefined);
	writeFileSync(join(dir, "c.txt"), "c\n");
	assert.equal(mergedBranch(dir, () => "MERGED"), undefined, "uncommitted work stays where it is");
	execFileSync("rm", [join(dir, "c.txt")]);
	gitIn(dir, "switch", "main");
	assert.equal(mergedBranch(dir, () => "MERGED"), undefined, "already on main");
});

test("switchToMain moves the checkout to main and reports its head", () => {
	const dir = mkdtempSync(join(tmpdir(), "guard-switch-"));
	repoOnFeat(dir);
	const head = switchToMain(dir);
	assert.equal(gitIn(dir, "branch", "--show-current"), "main");
	assert.equal(head, gitIn(dir, "rev-parse", "--short", "HEAD"));
});

test("the first call into an app whose checkout sits on a merged branch switches it to main and says so in the result, once", () => {
	const home = mkdtempSync(join(tmpdir(), "guard-home-"));
	const dir = join(home, "workspace", "apps", "keeb");
	mkdirSync(dir, { recursive: true });
	repoOnFeat(dir);
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	piGuard({ on: (event, handler) => void (handlers[event] = handler) }, () => false, { HOME: home }, undefined, () => "MERGED");
	const ctx = { cwd: "/", sessionManager: { getBranch: () => [] } };
	assert.equal(handlers.tool_call({ toolName: "bash", toolCallId: "c1", input: { command: `cd ${dir} && git status --short` } }, ctx), undefined);
	assert.equal(gitIn(dir, "branch", "--show-current"), "main");
	const r = handlers.tool_result({ toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "" }] }, ctx);
	assert.match(r.content.at(-1).text, /was still on branch feat, whose PR is merged; switched it to main/);
	// The next call into the app is not checked again, and its result is untouched.
	assert.equal(handlers.tool_call({ toolName: "bash", toolCallId: "c2", input: { command: `cd ${dir} && ls` } }, ctx), undefined);
	assert.equal(handlers.tool_result({ toolName: "bash", toolCallId: "c2", content: [{ type: "text", text: "a.txt" }] }, ctx), undefined);
});

test("a worker brief naming an app triggers the merged-branch check; a child session never does", () => {
	const home = mkdtempSync(join(tmpdir(), "guard-home-"));
	const dir = join(home, "workspace", "apps", "keeb");
	mkdirSync(dir, { recursive: true });
	repoOnFeat(dir);
	let asked = 0;
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	piGuard({ on: (event, handler) => void (handlers[event] = handler) }, () => false, { HOME: home, PI_SUBAGENT_CHILD: "1" }, undefined, () => (asked++, "MERGED"));
	handlers.tool_call({ toolName: "bash", toolCallId: "c1", input: { command: `cd ${dir} && ls` } }, { cwd: "/" });
	assert.equal(asked, 0);
	assert.equal(gitIn(dir, "branch", "--show-current"), "feat");
	const parent: Record<string, (event: any, ctx: any) => any> = {};
	piGuard({ on: (event, handler) => void (parent[event] = handler) }, () => false, { HOME: home }, undefined, () => (asked++, "MERGED"));
	parent.tool_call({ toolName: "subagent", toolCallId: "s1", input: { agent: "worker", task: `Implement the thing in ${dir}. Run npm test.` } }, { cwd: "/", sessionManager: { getBranch: () => [] } });
	assert.equal(asked, 1);
	assert.equal(gitIn(dir, "branch", "--show-current"), "main");
});

test("scopeReview: a tree whose last review ended BLOCK is not reviewed again; the fix is", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	const { snap } = scopeReview({ agent: "reviewer", task: "Review /tmp/keeb-review.diff" }, ready(dir), home, home) as { snap: string };
	const after = [...ready(dir), msg("toolResult", { toolCallId: "r", isError: false, content: [{ type: "text", text: reviewBlockedMark(dir, snap) }] })];
	assert.equal(upToDate(dir, after), false, "a BLOCK never opens the gate");
	assert.deepEqual(scopeReview({ agent: "reviewer", cwd: dir, task: "Re-verify your P0" }, after, home, home), { block: true, reason: REASONS.reviewBlockedSame });
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n");
	const second: Record<string, unknown> = { agent: "reviewer", task: "Review /tmp/keeb-review.diff" };
	assert.ok(!("block" in (scopeReview(second, [...after, ...looked(dir)], home, home) ?? {})), "the fixed tree gets its review");
	assert.match(String(second.task), /- src\/a\.ts/, "the diff still holds the blocked change, from main");
});

test("tool_result marks a sync BLOCK as blocked, not reviewed", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n");
	const h = load(() => false, { HOME: home });
	const ctx = { cwd: dir, sessionManager: { getBranch: () => ready(dir) } };
	const sync: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb" };
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "b1", input: sync }, ctx), undefined);
	const r = h.tool_result({ toolCallId: "b1", toolName: "subagent", content: [{ type: "text", text: "## Review\n- Finding: P0 - broken\n- Merge verdict: BLOCK" }], isError: false }, ctx);
	const text = r.content.map((c: any) => c.text ?? "").join("\n");
	assert.match(text, /\[pi-guard\] review blocked \S+ at [0-9a-f]{40}/);
	assert.doesNotMatch(text, /\[pi-guard\] reviewed /);
});

test("docsChanged: a spec or plan on the branch, committed or not; plain Markdown is not one", () => {
	const { dir, git } = appRepo();
	assert.equal(docsChanged(dir), false);
	writeFileSync(join(dir, "README.md"), "hi");
	assert.equal(docsChanged(dir), false, "README");
	mkdirSync(join(dir, "docs", "superpowers", "plans"), { recursive: true });
	writeFileSync(join(dir, "docs", "superpowers", "plans", "2026-11-17-x.md"), "# plan");
	assert.equal(docsChanged(dir), true, "untracked plan");
	git("add", "-A");
	git("commit", "-qm", "plan");
	assert.equal(docsChanged(dir), true, "committed plan");
});

test("scopeReview: a docs-only change is reviewed without verify or a screen, with the doc brief", () => {
	const { home, dir } = appRepo();
	mkdirSync(join(dir, "docs", "superpowers", "plans"), { recursive: true });
	writeFileSync(join(dir, "docs", "superpowers", "plans", "2026-11-17-x.md"), "# plan\n");
	const input: Record<string, unknown> = { agent: "reviewer", cwd: dir, task: "Review the plan for holes" };
	const r = scopeReview(input, [msg("user", { content: "spin up a reviewer" })], home, home);
	assert.ok(r && !("block" in r), `scoped: ${JSON.stringify(r)}`);
	assert.match(String(input.task), /review of an implementation plan, not of code/);
	assert.match(String(input.task), /- docs\/superpowers\/plans\/2026-11-17-x\.md/);
	assert.doesNotMatch(String(input.task), /verify/);
	// Code on top of it brings the verify gate back.
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	assert.deepEqual(scopeReview({ agent: "reviewer", cwd: dir, task: "Review" }, [], home, home), { block: true, reason: REASONS.reviewUnverified });
});

// --- the review gate on any repo under ~/workspace ---

function wsRepo(trunk = "master") {
	const home = mkdtempSync(join(tmpdir(), "guard-home-"));
	const dir = join(home, "workspace", "ref", "site");
	mkdirSync(join(dir, "src"), { recursive: true });
	const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });
	git("init", "-q", "-b", trunk);
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "one");
	git("switch", "-qc", "next");
	return { home, dir, git };
}

test("repoRoot: a git repo under ~/workspace outside apps, by any path in it; apps, loose dirs and outside paths are not", () => {
	const { home, dir } = wsRepo();
	assert.equal(repoRoot(join(dir, "src", "new.ts"), home), dir, "a file that does not exist yet");
	assert.equal(repoRoot(dir, home), dir);
	assert.equal(repoRoot(join(home, "workspace", "apps", "keeb"), home), undefined);
	mkdirSync(join(home, "workspace", "loose"));
	assert.equal(repoRoot(join(home, "workspace", "loose"), home), undefined);
	assert.equal(repoRoot(join(home, "elsewhere"), home), undefined);
	assert.equal(mainBranch(dir), "master");
});

test("scopeReview scopes a reviewer call on a workspace repo outside apps, by cwd or by a path in the task, against its master", () => {
	const { home, dir } = wsRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	assert.equal(codeChanged(dir), true, "read against master, not a failed `main` diff");
	const input: Record<string, unknown> = { agent: "reviewer", cwd: dir, task: "Review the branch" };
	const r = scopeReview(input, [msg("user", { content: "rebuild it" })], home, home) as { dir: string; snap: string };
	assert.equal(r.dir, dir, "no verify script and no screen gate: scoped straight away");
	assert.equal(input.cwd, dir);
	assert.match(String(input.task), /- src\/a\.ts \(\+1 -1\)/);
	assert.match(String(input.task), /rebuild it/);
	const byPath: Record<string, unknown> = { agent: "reviewer", task: `Review ${join(dir, "src")} against master` };
	assert.equal((scopeReview(byPath, [], home, home) as { dir: string }).dir, dir, "a path inside the repo scopes to its root");
	assert.equal(scopeReview({ agent: "reviewer", cwd: join(home, "workspace", "nowhere"), task: "Review" }, [], home, home), undefined, "not a repo");
});

test("through pi: a push from a workspace repo outside apps is blocked until its tree was reviewed", () => {
	const { home, dir } = wsRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	const h = load(() => false, { HOME: home });
	const ctx = (branch: unknown[]) => ({ cwd: home, sessionManager: { getBranch: () => branch } });
	const push = { toolName: "bash", input: { command: `cd ${dir} && git push -u origin next` } };
	const r = h.tool_call(push, ctx([msg("user", { content: "ship it" })]));
	assert.match(String(r?.reason), /^Blocked: run the reviewer before opening the PR or pushing this branch/);
	assert.match(String(r?.reason), /No reviewer call since Michael's last message/);
	const pr = { toolName: "bash", input: { command: `cd ${dir} && gh pr create --base master --head next --title t --body b` } };
	assert.match(String(h.tool_call(pr, ctx([]))?.reason), /^Blocked: run the reviewer/);
	const reviewed = [msg("user", { content: "ship it" }), msg("toolResult", { toolCallId: "r", isError: false, content: [{ type: "text", text: reviewMark(dir, snapshot(dir)) }] })];
	assert.equal(h.tool_call(push, ctx(reviewed)), undefined, "the tree as the review left it may go");
	// One finished review per user message opens the gate (fixing its P2s and pushing needs no second review, as in apps);
	// Michael's next message shuts it again until the new tree is reviewed.
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n");
	assert.equal(h.tool_call(push, ctx(reviewed)), undefined, "a fix after the review in the same turn may go");
	assert.match(String(h.tool_call(push, ctx([...reviewed, msg("user", { content: "and now this" })]))?.reason), /^Blocked: run the reviewer/, "a new request needs a new review");
	assert.equal(h.tool_call({ toolName: "bash", input: { command: `cd ${dir} && npm test` } }, ctx([])), undefined, "only publishing is gated");
});

test("through pi: a run that edited a workspace repo outside apps and left it unpushed gets the PR nudge", () => {
	const { home, dir } = wsRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	assert.equal(needsPr(dir), true, "a branch off master, never pushed");
	const finished = [
		{ role: "user", content: "rebuild it" },
		{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "edit", arguments: { path: join(dir, "src", "a.ts") } }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done, the branch is ready on your side. " + "x".repeat(400) }] },
	];
	const ctx = { cwd: home, sessionManager: { getBranch: () => [] } };
	const r = load(needsPr, { HOME: home }).agent_before_settle({ outcome: "completed", context: { contextMessages: finished } }, ctx);
	assert.equal(r.entries[0].customType, PR_NUDGE_TYPE);
	assert.match(r.entries[0].content, /ref\/site|\bsite\b/);
	assert.match(r.entries[0].content, /gh pr create/);
	assert.doesNotMatch(r.entries[0].content, /thatsit-app\.ts/, "the app skill's commands are not for this repo");
});

test("the first call into a workspace repo outside apps whose checkout sits on a merged branch switches it to its trunk", () => {
	const { home, dir } = wsRepo("master");
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	piGuard({ on: (event, handler) => void (handlers[event] = handler) }, () => false, { HOME: home }, undefined, () => "MERGED");
	const ctx = { cwd: "/", sessionManager: { getBranch: () => [] } };
	assert.equal(handlers.tool_call({ toolName: "bash", toolCallId: "c1", input: { command: `cd ${dir} && git status --short` } }, ctx), undefined);
	assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim(), "master");
	const r = handlers.tool_result({ toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "" }] }, ctx);
	assert.match(r.content.at(-1).text, /was still on branch next, whose PR is merged; switched it to master/);
});

test("the first call into an app from a session whose cwd is elsewhere gets the app's AGENTS.md and the skill's style rules on its result, once per app and again after a compaction", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "AGENTS.md"), "# keeb\n\n- Files under src stay under 400 lines.\n");
	mkdirSync(join(home, ".pi", "agent", "skills", "thatsit-app"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "skills", "thatsit-app", "SKILL.md"), "---\nname: thatsit-app\n---\n\n# apps\n\n## Change an existing app\n\n1. branch\n\n## Style rules\n\n- Use only kit components: `tk-sheet`.\n\n## When something fails\n\n- rerun\n");
	const h = load(() => false, { HOME: home });
	const entries: unknown[] = [];
	const ctx = { cwd: home, sessionManager: { getBranch: () => entries } };
	assert.equal(h.tool_call({ toolName: "bash", toolCallId: "c1", input: { command: `cd ${dir} && git status --short` } }, ctx), undefined);
	const r = h.tool_result({ toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "" }] }, ctx);
	assert.equal(r.content.length, 2);
	assert.match(r.content[1].text, /^\[pi-guard\] The rules of .*\/workspace\/apps\/keeb, which this session's cwd did not load/);
	assert.match(r.content[1].text, /<project_instructions path="[^"]*\/keeb\/AGENTS\.md">\n# keeb\n\n- Files under src stay under 400 lines\.\n<\/project_instructions>/);
	assert.match(r.content[1].text, /From the thatsit-app skill[\s\S]*## Style rules\n\n- Use only kit components: `tk-sheet`\.$/);
	// The second call into the app carries nothing more.
	assert.equal(h.tool_call({ toolName: "edit", toolCallId: "c2", input: { path: join(dir, "src", "a.ts") } }, ctx), undefined);
	assert.equal(h.tool_result({ toolName: "edit", toolCallId: "c2", content: [{ type: "text", text: "ok" }] }, ctx), undefined);
	// A compaction summarises the brief away, so the next call into the app gets it again.
	h.session_before_compact({ preparation: { messagesToSummarize: [], turnPrefixMessages: [] } }, ctx);
	h.tool_call({ toolName: "bash", toolCallId: "c3", input: { command: `cd ${dir} && ls` } }, ctx);
	assert.match(h.tool_result({ toolName: "bash", toolCallId: "c3", content: [{ type: "text", text: "" }] }, ctx).content[1].text, /^\[pi-guard\] The rules of/);
	// A blocked call delivers nothing, and does not spend the one delivery.
	const h2 = load(() => false, { HOME: home });
	assert.equal(h2.tool_call({ toolName: "bash", toolCallId: "b1", input: { command: `cd ${dir} && git push` } }, ctx)?.block, true);
	h2.tool_call({ toolName: "bash", toolCallId: "b2", input: { command: `cd ${dir} && ls` } }, ctx);
	assert.match(h2.tool_result({ toolName: "bash", toolCallId: "b2", content: [{ type: "text", text: "" }] }, ctx).content[1].text, /^\[pi-guard\] The rules of/);
});

test("a session whose cwd is in the app already has AGENTS.md, so it gets the style rules alone; a read of the skill makes the brief unnecessary", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "AGENTS.md"), "# keeb\n");
	mkdirSync(join(home, ".pi", "agent", "skills", "thatsit-app"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "skills", "thatsit-app", "SKILL.md"), "# apps\n\n## Style rules\n\n- kit only\n");
	// A pi-subagents worker: a child whose cwd is the app (or one of its worktrees).
	const child = load(() => false, { HOME: home, PI_SUBAGENT_CHILD: "1" });
	const ctx = { cwd: join(dir, "src"), sessionManager: { getBranch: () => [] } };
	child.tool_call({ toolName: "edit", toolCallId: "c1", input: { path: join(dir, "src", "a.ts") } }, ctx);
	const r = child.tool_result({ toolName: "edit", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }, ctx);
	assert.equal(r.content.length, 2);
	assert.match(r.content[1].text, /^\[pi-guard\] From the thatsit-app skill[\s\S]*- kit only$/);
	assert.doesNotMatch(r.content[1].text, /project_instructions/);
	// The skill already read on the branch: its rules are in context, and the app's AGENTS.md too.
	const read = [msg("assistant", { content: [{ type: "toolCall", id: "r", name: "read", arguments: { path: "~/.pi/agent/skills/thatsit-app/SKILL.md" } }] })];
	const parent = load(() => false, { HOME: home });
	parent.tool_call({ toolName: "bash", toolCallId: "p1", input: { command: `cd ${dir} && ls` } }, { ...ctx, sessionManager: { getBranch: () => read } });
	assert.equal(parent.tool_result({ toolName: "bash", toolCallId: "p1", content: [{ type: "text", text: "" }] }, ctx), undefined);
	// A session in an app with no AGENTS.md and no skill on disk gets nothing at all.
	const bare = appRepo();
	const b = load(() => false, { HOME: bare.home });
	b.tool_call({ toolName: "bash", toolCallId: "n1", input: { command: `cd ${bare.dir} && ls` } }, { cwd: bare.home, sessionManager: { getBranch: () => [] } });
	assert.equal(b.tool_result({ toolName: "bash", toolCallId: "n1", content: [{ type: "text", text: "" }] }, { cwd: bare.home }), undefined);
});

test("a scoped review of a UI change carries the kit rules; one that changes no UI file does not", () => {
	const { home, dir } = appRepo();
	mkdirSync(join(home, ".pi", "agent", "skills", "thatsit-app"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "skills", "thatsit-app", "SKILL.md"), "# apps\n\n## Style rules\n\n- Use only kit components: `tk-sheet`.\n");
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	const input: Record<string, unknown> = { agent: "reviewer", task: `Review ${dir}` };
	const r = scopeReview(input, ready(dir), home, home);
	assert.ok(r && !("block" in r));
	assert.match(String(input.task), /\[Kit rules\. The diff touches UI files \(src\/a\.ts\)[\s\S]*- Use only kit components: `tk-sheet`\./);
	const { home: h2, dir: d2 } = appRepo();
	mkdirSync(join(h2, ".pi", "agent", "skills", "thatsit-app"), { recursive: true });
	writeFileSync(join(h2, ".pi", "agent", "skills", "thatsit-app", "SKILL.md"), "# apps\n\n## Style rules\n\n- kit\n");
	mkdirSync(join(d2, "test"));
	writeFileSync(join(d2, "test", "a.test.ts"), "it('x', () => {});\n");
	const input2: Record<string, unknown> = { agent: "reviewer", task: `Review ${d2}` };
	assert.ok(!("block" in (scopeReview(input2, verified(d2), h2, h2) ?? {})));
	assert.doesNotMatch(String(input2.task), /Kit rules/);
});

// --- a resume of a reviewer run is a review of the tree as it is now (keeb 2026-11-22: two resumes, three blocked `pr` calls) ---

test("a resume of a reviewer run is scoped like a fresh review: gated, briefed with the diff, and its revived run gets the pending mark", () => {
	const { home, dir, git } = appRepo();
	// Synthetic ids: a real one would resolve against this machine's pi-subagents run dirs.
	const L = "aaaa1111-0000-4000-8000-000000000001";
	const X = "bbbb2222-0000-4000-8000-000000000002";
	const first = snapshot(dir);
	const launched = [msg("toolResult", { toolCallId: "r1", isError: false, content: [{ type: "text", text: `Async: reviewer [${L}]\n${reviewPendingMark(dir, first, L)}` }] })];
	const h = load(() => false, { HOME: home });
	const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");
	// Nothing changed since the review that run covers: nothing to resume into.
	const same: Record<string, unknown> = { action: "resume", id: "aaaa1111", message: "Look again." };
	assert.deepEqual(h.tool_call({ toolName: "subagent", toolCallId: "r2", input: same }, { cwd: dir, sessionManager: { getBranch: () => [...ready(dir), ...launched] } }), { block: true, reason: REASONS.reviewNothing });
	// The fix pass edited code: the resume is gated on verify like a fresh call.
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 9;\n");
	git("add", "-A");
	git("commit", "-qm", "fix");
	const edited = [msg("assistant", { content: [{ type: "toolCall", id: "e", name: "edit", arguments: { path: join(dir, "src", "a.ts") } }] })];
	const unverified: Record<string, unknown> = { action: "resume", id: "aaaa1111", message: "Your P1s are fixed in 9a0e059." };
	assert.deepEqual(h.tool_call({ toolName: "subagent", toolCallId: "r3", input: unverified }, { cwd: dir, sessionManager: { getBranch: () => [...launched, ...edited] } }), { block: true, reason: REASONS.reviewUnverified });
	// Verified and looked at: the resume message gets the review scope, nothing else on the call changes.
	const branch = [...launched, ...edited, ...ready(dir)];
	const ctx = { cwd: dir, sessionManager: { getBranch: () => branch } };
	const input: Record<string, unknown> = { action: "resume", id: "aaaa1111", message: "Your P1s are fixed in 9a0e059." };
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "r4", input }, ctx), undefined);
	assert.match(String(input.message), /^\[Review scope, set by pi-guard\. Follow it exactly\.\][\s\S]*Diff: \/tmp\/keeb-review\.diff[\s\S]*\[The parent's request\]\nYour P1s are fixed in 9a0e059\.$/);
	assert.match(String(input.message), /src\/a\.ts/);
	assert.equal(input.task, undefined);
	assert.equal(input.cwd, undefined);
	assert.equal(input.toolBudget, undefined);
	assert.equal(input.id, "aaaa1111");
	const r4 = h.tool_result({ toolCallId: "r4", toolName: "subagent", content: [{ type: "text", text: `Revived async subagent from ${L}.\nRevived run: ${X}\nAgent: reviewer` }], isError: false }, ctx);
	assert.match(text(r4), new RegExp(`\\[pi-guard\\] review pending \\S+ at ${snapshot(dir)} run ${X}`));
	// A resume of a run that is not a reviewer's goes through untouched.
	const worker: Record<string, unknown> = { action: "resume", id: "96ab932e", message: "Remove the border." };
	assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "r5", input: worker }, ctx), undefined);
	assert.equal(worker.message, "Remove the border.");
	assert.equal(h.tool_result({ toolCallId: "r5", toolName: "subagent", content: [{ type: "text", text: "Revived async subagent from 96ab932e-2cba-4b01-ac45-7d286b918a4b.\nRevived run: 11111111-2222-4333-8444-555555555555" }], isError: false }, ctx), undefined);
});

test("a reviewer or worker launch runs on the session's model when the configured one is not loaded; a loaded configured model is left to pi-subagents", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 6;\n");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ defaultModel: "spark/flash-auto", subagents: { agentOverrides: { reviewer: { model: "spark/qwen3.8-flash-next" } }, defaultModel: "spark/qwen3.8-flash-next" } }));
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	let loaded = ["inkling-2-mini"];
	piGuard({ on: (event, handler) => void (handlers[event] = handler) }, () => false, { HOME: home }, () => loaded);
	const ctx = (id: string) => ({ cwd: dir, model: { provider: "spark", id }, sessionManager: { getBranch: () => ready(dir) } });
	const review: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb" };
	assert.equal(handlers.tool_call({ toolName: "subagent", toolCallId: "m1", input: review }, ctx("inkling-2-mini")), undefined);
	assert.equal(review.model, "spark/inkling-2-mini");
	const work: Record<string, unknown> = { agent: "worker", task: "Build the toggle", cwd: dir };
	assert.equal(handlers.tool_call({ toolName: "subagent", toolCallId: "m2", input: work }, ctx("inkling-2-mini")), undefined);
	assert.equal(work.model, "spark/inkling-2-mini");
	loaded = ["qwen3.8-flash-next"];
	const flash: Record<string, unknown> = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb" };
	assert.equal(handlers.tool_call({ toolName: "subagent", toolCallId: "m3", input: flash }, ctx("flash-auto")), undefined);
	assert.equal(flash.model, undefined, "the configured Flash-Next is loaded: pi-subagents applies it");
	const status: Record<string, unknown> = { action: "status", id: "cc9f4fa1" };
	assert.equal(handlers.tool_call({ toolName: "subagent", toolCallId: "m4", input: status }, ctx("inkling-2-mini")), undefined);
	assert.equal(status.model, undefined, "a status call names no agent and gets no model");
});

{
	const shotCmd = (dir: string) => `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts screenshot ${dir}`;
	const prCmd = (dir: string) => `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ${dir} --title t --body b`;
	const opened = (dir: string) => [
		msg("assistant", { content: [{ type: "toolCall", id: "p1", name: "preview", arguments: { cwd: dir } }] }),
		msg("toolResult", { toolCallId: "p1", toolName: "preview", isError: false, details: { url: "https://x" } }),
	];
	// A tree the PR gates let through: verified, looked at, reviewed as it is.
	const gated = (dir: string) => [...ready(dir), msg("toolResult", { toolCallId: "r", isError: false, content: [{ type: "text", text: reviewMark(dir, snapshot(dir)) }] })];
	const ctxOf = (home: string, entries: unknown[]) => ({ cwd: home, sessionManager: { getBranch: () => entries } });
	const result = (id: string, command: string) => ({ toolName: "bash", toolCallId: id, input: { command }, isError: false, content: [{ type: "text", text: "ok" }] });
	const notes = (out: any, dir: string, when: "review" | "pr" = "pr") => out?.content?.filter((c: any) => c.text === previewNote(dir, when)).length ?? 0;

	const reviewCall = { agent: "reviewer", task: "Review keeb at ~/workspace/apps/keeb" };
	const reviewResult = (id: string) => ({ toolCallId: id, toolName: "subagent", isError: false, content: [{ type: "text", text: "## Review\n- Checked: a.ts\n- Merge verdict: OK" }] });

	test("the scoped reviewer result carries the preview note once, when UI changed and no preview was opened; a screenshot never does", () => {
		const { home, dir } = appRepo();
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
		const h = load(() => false, { HOME: home });
		const ctx = ctxOf(home, ready(dir));
		h.tool_call({ toolName: "bash", toolCallId: "s1", input: { command: shotCmd(dir) } }, ctx);
		assert.equal(notes(h.tool_result(result("s1", shotCmd(dir)), ctx), dir, "review"), 0, "not on the screenshot");
		assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "v1", input: { ...reviewCall } }, ctx), undefined);
		assert.equal(notes(h.tool_result(reviewResult("v1"), ctx), dir, "review"), 1);
		h.tool_call({ toolName: "subagent", toolCallId: "v2", input: { ...reviewCall } }, ctx);
		assert.equal(notes(h.tool_result(reviewResult("v2"), ctx), dir, "review"), 0, "once");
	});

	test("a reviewer call then a pr in one session: the note rides on the reviewer result only", () => {
		const { home, dir } = appRepo();
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
		const h = load(() => false, { HOME: home });
		const before = ctxOf(home, ready(dir));
		assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "v1", input: { ...reviewCall } }, before), undefined);
		assert.equal(notes(h.tool_result(reviewResult("v1"), before), dir, "review"), 1);
		// The review's mark is on the branch now, so the PR gates let the pr through.
		const ctx = ctxOf(home, gated(dir));
		assert.equal(h.tool_call({ toolName: "bash", toolCallId: "r1", input: { command: prCmd(dir) } }, ctx), undefined, "the gates let it through");
		const out = h.tool_result(result("r1", prCmd(dir)), ctx);
		assert.equal(notes(out, dir, "pr") + notes(out, dir, "review"), 0);
	});

	test("a reviewer result gets no preview note when a preview was opened for the app", () => {
		const { home, dir } = appRepo();
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
		const h = load(() => false, { HOME: home });
		const ctx = ctxOf(home, [...ready(dir), ...opened(dir)]);
		h.tool_call({ toolName: "subagent", toolCallId: "v1", input: { ...reviewCall } }, ctx);
		assert.equal(notes(h.tool_result(reviewResult("v1"), ctx), dir, "review"), 0);
	});

	test("a pr with UI changes and no preview gets the note; with a preview call in the branch it does not", () => {
		const { home, dir } = appRepo();
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
		const h = load(() => false, { HOME: home });
		const ctx = ctxOf(home, gated(dir));
		assert.equal(h.tool_call({ toolName: "bash", toolCallId: "r1", input: { command: prCmd(dir) } }, ctx), undefined, "the gates let it through");
		assert.equal(notes(h.tool_result(result("r1", prCmd(dir)), ctx), dir), 1);
		const h2 = load(() => false, { HOME: home });
		const ctx2 = ctxOf(home, [...gated(dir), ...opened(dir)]);
		h2.tool_call({ toolName: "bash", toolCallId: "r1", input: { command: prCmd(dir) } }, ctx2);
		assert.equal(notes(h2.tool_result(result("r1", prCmd(dir)), ctx2), dir), 0);
	});

	test("a docs-only pr gets no preview note", () => {
		const { home, dir } = appRepo();
		mkdirSync(join(dir, "docs"), { recursive: true });
		writeFileSync(join(dir, "docs", "spec.md"), "# Spec\n");
		const h = load(() => false, { HOME: home });
		const ctx = ctxOf(home, gated(dir));
		h.tool_call({ toolName: "bash", toolCallId: "r1", input: { command: prCmd(dir) } }, ctx);
		assert.equal(notes(h.tool_result(result("r1", prCmd(dir)), ctx), dir), 0);
	});

	test("a chat session never gets the preview note", () => {
		const { home, dir } = appRepo();
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
		const h = load(() => false, { HOME: home, PI_WEB_SESSION_TYPE: "chat" });
		const before = ctxOf(home, ready(dir));
		assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "v1", input: { ...reviewCall } }, before), undefined);
		assert.equal(notes(h.tool_result(reviewResult("v1"), before), dir, "review"), 0);
		const ctx = ctxOf(home, gated(dir));
		assert.equal(h.tool_call({ toolName: "bash", toolCallId: "r1", input: { command: prCmd(dir) } }, ctx), undefined);
		assert.equal(notes(h.tool_result(result("r1", prCmd(dir)), ctx), dir), 0);
	});

	test("no preview note in a subagent child", () => {
		const { home, dir } = appRepo();
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
		const h = load(() => false, { HOME: home, PI_SUBAGENT_CHILD: "1" });
		const before = ctxOf(home, ready(dir));
		assert.equal(h.tool_call({ toolName: "subagent", toolCallId: "v1", input: { ...reviewCall } }, before), undefined);
		assert.equal(notes(h.tool_result(reviewResult("v1"), before), dir, "review"), 0);
		const ctx = ctxOf(home, gated(dir));
		assert.equal(h.tool_call({ toolName: "bash", toolCallId: "r1", input: { command: prCmd(dir) } }, ctx), undefined);
		assert.equal(notes(h.tool_result(result("r1", prCmd(dir)), ctx), dir), 0);
	});
}

test("inherited changes: the first call into a dirty app notes the files, and a commit waits for Michael to keep them", () => {
	const { home, dir } = appRepo();
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	const h = load(() => false, { HOME: home });
	const entries: unknown[] = [msg("user", { content: "fix the sync bug" })];
	const ctx = { cwd: home, sessionManager: { getBranch: () => entries } };
	const look = { toolName: "bash", toolCallId: "l1", input: { command: `cd ${dir} && git status --short` } };
	assert.equal(h.tool_call(look, ctx), undefined, "the first call itself goes through");
	const out = h.tool_result({ ...look, isError: false, content: [{ type: "text", text: " M src/a.ts" }] }, ctx);
	assert.match(out.content.at(-1).text, new RegExp(`^\\[pi-guard\\] inherited changes ${dir}: src/a\\.ts\\n`));
	entries.push(msg("toolResult", { toolCallId: "l1", isError: false, content: out.content }));
	const commit = { toolName: "bash", toolCallId: "c1", input: { command: `cd ${dir} && git add -A && git commit -m "feat: focus letters"` } };
	assert.match(h.tool_call(commit, ctx)?.reason ?? "", /^Blocked: src\/a\.ts was changed before this session/);
	// A second call into the app adds no second note.
	assert.equal(h.tool_call({ ...look, toolCallId: "l2" }, ctx), undefined);
	assert.equal(h.tool_result({ ...look, toolCallId: "l2", isError: false, content: [{ type: "text", text: "x" }] }, ctx), undefined);
	entries.push(msg("user", { content: "keep it, that one's mine" }));
	assert.equal(h.tool_call(commit, ctx), undefined, "Michael kept it");
});

test("a UI edit in an app gets the kit patterns it touches on its result, each once per app and again after a compaction", () => {
	const { home, dir } = appRepo();
	const h = load(() => false, { HOME: home });
	const ctx = { cwd: home, sessionManager: { getBranch: () => [] } };
	const edit = (id: string, path: string, newText: string) => {
		assert.equal(h.tool_call({ toolName: "edit", toolCallId: id, input: { path, edits: [{ oldText: "a", newText }] } }, ctx), undefined);
		const r = h.tool_result({ toolName: "edit", toolCallId: id, content: [{ type: "text", text: "ok" }] }, ctx);
		return (r?.content ?? [{ type: "text", text: "ok" }]).map((c: { text: string }) => c.text).find((t: string) => t.startsWith(KIT_PATTERNS_MARK));
	};
	const first = edit("e1", join(dir, "src", "ui", "settings-dialog.ts"), 'html`<dialog open><div class="form"><label for="g">Goal</label><input id="g"></div></dialog>`');
	assert.ok(first, "the first UI edit carries the patterns");
	assert.match(first!, /- This edit builds a `<dialog>` by hand/);
	assert.match(first!, /## Overlays: Settings dialog\n[^\n]*\n```html\n<tk-sheet heading="Settings"/);
	assert.match(first!, /## Forms: Pattern CSS\n```css\n\.form \{ display: grid;/);
	assert.doesNotMatch(first!, /## Icons/);
	// The same patterns again: nothing; a new one: only it. A departure is always said.
	assert.equal(edit("e2", join(dir, "src", "ui", "settings-dialog.ts"), 'html`<div class="form"><label>x</label><select></select></div>`'), undefined);
	const icons = edit("e3", join(dir, "src", "ui", "icons.ts"), 'export const EYE = svg`<path d="M2 12s3-7 10-7"/>`');
	assert.match(icons!, /- Pasted SVG/);
	assert.match(icons!, /## Icons\n/);
	assert.doesNotMatch(icons!, /## Forms/);
	// Logic with no UI in it: nothing. A write of a new UI file counts like an edit.
	assert.equal(edit("e4", join(dir, "src", "lesson", "ladder.ts"), "export function next(stats: StatMap) { return 1; }"), undefined);
	assert.equal(h.tool_call({ toolName: "write", toolCallId: "w1", input: { path: join(dir, "src", "ui", "boards.ts"), content: 'html`<div class="rows"><div class="row"></div></div>`' } }, ctx), undefined);
	const rows = h.tool_result({ toolName: "write", toolCallId: "w1", content: [{ type: "text", text: "ok" }] }, ctx).content.map((c: { text: string }) => c.text).find((t: string) => t.startsWith(KIT_PATTERNS_MARK));
	assert.match(rows, /## Lists & cards\n/);
	// After a compaction the summary has lost the patterns: the next edit touching one gets it again.
	h.session_before_compact({ preparation: { messagesToSummarize: [], turnPrefixMessages: [] } }, ctx);
	assert.match(edit("e5", join(dir, "src", "ui", "settings-dialog.ts"), 'html`<tk-sheet heading="Settings"><div class="form"></div></tk-sheet>`')!, /## Overlays: Settings dialog/);
});

test("onTrunk: true on main or master, false on a branch, in detached HEAD or outside a repo", () => {
	const { dir, git } = wsRepo();
	assert.equal(onTrunk(dir), false, "on next");
	git("switch", "-q", "master");
	assert.equal(onTrunk(dir), true);
	git("switch", "-q", "--detach");
	assert.equal(onTrunk(dir), false);
	assert.equal(onTrunk(join(dir, "missing")), false);
});

test("scopeReview: commits made on main are reviewed against origin/main, not against main itself", () => {
	// website 2026-11-24: the orchestrator committed on main, so merge-base(main, HEAD) was HEAD, the reviewer call was
	// refused as "nothing changed" and the push stayed gated, with no review possible.
	const { home, dir, git } = wsRepo("main");
	const remote = mkdtempSync(join(tmpdir(), "guard-remote-"));
	execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote, stdio: "pipe" });
	git("remote", "add", "origin", remote);
	git("switch", "-q", "main");
	git("push", "-qu", "origin", "main");
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	git("commit", "-qam", "on main");
	assert.equal(codeChanged(dir), true);
	const input: Record<string, unknown> = { agent: "reviewer", cwd: dir, task: "Review the change" };
	const r = scopeReview(input, [msg("user", { content: "drop the submodule" })], home, home) as { dir: string };
	assert.equal(r.dir, dir, "a review, not reviewNothing");
	assert.match(String(input.task), /src\/a\.ts \(\+1 -1\)/);
	assert.match(readFileSync("/tmp/site-review.diff", "utf8"), /\+export const a = 2;/);
	git("push", "-q", "origin", "main");
	assert.deepEqual(scopeReview({ agent: "reviewer", cwd: dir, task: "Review the change" }, [msg("user", { content: "drop the submodule" })], home, home), { block: true, reason: REASONS.reviewNothing }, "once pushed, nothing differs from origin/main");
});

test("a repo outside apps whose page loads the kit gets the kit handover too, start and layout sections included", () => {
	const { home, dir } = wsRepo();
	writeFileSync(join(dir, "index.html"), '<!doctype html><link rel="stylesheet" href="https://kit.thatsit.app/kit.css">');
	const h = load(() => false, { HOME: home });
	const ctx = { cwd: home, sessionManager: { getBranch: () => [] } };
	assert.equal(h.tool_call({ toolName: "write", toolCallId: "w1", input: { path: join(dir, "app-main.js"), content: 'import { LitElement, html } from "https://kit.thatsit.app/lit.js";\nclass A extends LitElement { render() { return html`<tk-shell><tk-header></tk-header></tk-shell>`; } }' } }, ctx), undefined);
	const note = h.tool_result({ toolName: "write", toolCallId: "w1", content: [{ type: "text", text: "ok" }] }, ctx).content.map((c: { text: string }) => c.text).find((t: string) => t.startsWith(KIT_PATTERNS_MARK));
	assert.ok(note, "the write carries the kit sections");
	assert.match(note!, /## Start here\n/);
	assert.match(note!, /## Start here: A component\n/);
	assert.match(note!, /## Layout\n/);
	// A repo that does not load the kit gets nothing.
	const other = wsRepo();
	const h2 = load(() => false, { HOME: other.home });
	assert.equal(h2.tool_call({ toolName: "write", toolCallId: "w2", input: { path: join(other.dir, "app-main.js"), content: "class A extends LitElement {}" } }, { cwd: other.home, sessionManager: { getBranch: () => [] } }), undefined);
	const r2 = h2.tool_result({ toolName: "write", toolCallId: "w2", content: [{ type: "text", text: "ok" }] }, { cwd: other.home, sessionManager: { getBranch: () => [] } });
	assert.equal((r2?.content ?? []).some((c: { text: string }) => c.text.startsWith(KIT_PATTERNS_MARK)), false);
});
