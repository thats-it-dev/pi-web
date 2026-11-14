import { test } from "node:test";
import assert from "node:assert/strict";
import piGuard, { codeChanged, needsPr, scopeReview, screenUpToDate, snapshot, uiChanged, upToDate } from "../index.ts";
import { NUDGE_TYPE, PR_NUDGE_TYPE, REASONS, reviewedSinceUser, reviewMark, screenMark, TODO_NUDGE_TYPE } from "../rules.ts";
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

test("scopeReview keeps a resident model and strips any other, and a failed lookup strips", () => {
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
	assert.equal(strip.model, undefined);
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
	assert.equal(out.content.length, 7, "result, screen, spec, picture label, picture, comparison, mark");
	assert.deepEqual(out.content[1], { type: "image", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), mimeType: "image/png" });
	assert.match(out.content[2].text, /^docs\/spec\.md, what the screen must match:\n\n# Spec\n- Nut is drawn on the right edge\./);
	assert.equal(out.content[3].text, 'Michael sent this picture with: "Make it look like this"');
	assert.deepEqual(out.content[4], reference);
	assert.match(out.content[5].text, /^Compare the screen with docs\/spec\.md, Michael's pictures above .* and write down what differs/);
	assert.match(out.content[6].text, /^\[pi-guard\] screen seen /);
	entries.push(msg("toolResult", { toolCallId: "s1", isError: false, content: out.content }));
	assert.equal(screenUpToDate(dir, entries), true);
	const r2 = h.tool_call({ toolName: "bash", toolCallId: "pr2", input: { command: `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ${dir} --title t --body b` } }, ctx);
	assert.deepEqual(r2, { block: true, reason: REASONS.review }, "looked; the review gate is next");
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
