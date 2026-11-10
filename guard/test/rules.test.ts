import { checkShell, reviewedSinceUser, reviewFree } from "../rules.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appDir, appsNeedingPr, checkToolCall, PR_NUDGE_TYPE, prNudge, shouldNudgePr, discards, fullE2e, MAX_NUDGES, MAX_TODO_NUDGES, NUDGE_TYPE, openTodos, REASONS, shouldNudge, shouldNudgeTodos, TODO_NUDGE_TYPE, todoNudge, type Env } from "../rules.ts";

const home = "/home/m";
const env = (over: Partial<Env> = {}): Env => ({ cwd: home, home, hasScript: () => true, dirty: () => true, ...over });
const bash = (command: string, e = env()) => checkToolCall("bash", { command }, e)?.reason;
const app = "cd ~/workspace/apps/keeb && ";

test("appDir finds the app from the command or the cwd", () => {
	assert.equal(appDir("cd ~/workspace/apps/keeb && ls", home, home), "/home/m/workspace/apps/keeb");
	assert.equal(appDir("git -C $HOME/workspace/apps/tips status", home, home), "/home/m/workspace/apps/tips");
	assert.equal(appDir("ls", "/home/m/workspace/apps/keeb/src", home), "/home/m/workspace/apps/keeb");
	assert.equal(appDir("cd ~/workspace/pi-web && git push", home, home), undefined);
});

test("pushing from an app is blocked, commits that mention push are not", () => {
	assert.equal(bash(`${app}git push -u origin m5`), REASONS.push);
	assert.equal(bash(`${app}git -c user.name="A B" -c user.email=a@b push`), REASONS.push);
	assert.equal(bash(`${app}git commit -m "fix: push the key colour"`), undefined);
	assert.equal(bash("cd ~/workspace/pi-web && git push"), undefined);
});

test("waiting on CI is blocked; reading a failed log is not", () => {
	for (const c of ["timeout 1200 sleep 420; gh run list --branch m5", "gh run watch 42", "gh pr checks 13", "gh run view 42", "sleep 300"]) {
		assert.equal(bash(app + c), REASONS.ci, c);
	}
	assert.equal(bash(`${app}gh run view 42 --log-failed | tail -40`), undefined);
	assert.equal(bash(`${app}sleep 2 && curl -s localhost:4317`), undefined);
	assert.equal(bash(`${app}sleep 20 && node shot.cjs`), undefined);
});

test("the skill CLI is never blocked", () => {
	assert.equal(bash(`${app}node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/keeb --title "x"`), undefined);
});

test("fullE2e tells the whole suite from one spec", () => {
	assert.equal(fullE2e("npm run e2e"), true);
	assert.equal(fullE2e("npm run e2e 2>&1 | tail -5"), true);
	assert.equal(fullE2e("npx playwright test --project=desktop"), true);
	assert.equal(fullE2e("npm run e2e:one -- e2e/practice.spec.ts"), false);
	assert.equal(fullE2e("timeout 1200 npx playwright test e2e/history.spec.ts 2>&1 | grep passed"), false);
	assert.equal(fullE2e("npx playwright test -g offline"), false);
	assert.equal(fullE2e("BASE_URL=https://keeb.thatsit.app npm run e2e"), false);
	assert.equal(fullE2e("npm run verify"), false);
	assert.equal(fullE2e(`grep -n "^#\\+ \\|npm run e2e" README.md | head -40`), false);
	assert.equal(fullE2e(`git commit -m 'test: npm run e2e is faster'`), false);
});

test("the full suite is blocked only in apps that have e2e:one", () => {
	assert.equal(bash(`${app}npm run e2e`), REASONS.e2e);
	assert.equal(bash(`${app}npm run e2e`, env({ hasScript: () => false })), undefined);
});

test("Python file rewrites in an app are blocked, in bash and ctx_execute", () => {
	const py = `${app}python3 - <<'PY'\np="src/app-main.ts"; s=open(p).read()\nopen(p,"w").write(s.replace("a","b"))\nPY`;
	assert.equal(bash(py), REASONS.rewrite);
	assert.equal(bash(`${app}python3 -c 'print(open("src/x.ts").read())'`), undefined);
	// A scratch file in /tmp, even when the script mentions the app.
	assert.equal(bash(`cd /tmp && python3 - <<'PY'\nopen("m3check.cjs","w").write("~/workspace/apps/keeb")\nPY`), undefined);
	const code = 'from pathlib import Path\nPath("/home/m/workspace/apps/keeb/src/x.ts").write_text("y")';
	assert.equal(checkToolCall("ctx_execute", { language: "python", code }, env())?.reason, REASONS.rewrite);
	assert.equal(checkToolCall("ctx_execute", { language: "python", code: 'open("/tmp/x","w")' }, env()), undefined);
});

test("ctx_execute shell and ctx_batch_execute go through the same rules", () => {
	assert.equal(checkToolCall("ctx_execute", { language: "shell", code: `${app}sleep 420` }, env())?.reason, REASONS.ci);
	const commands = [{ label: "a", command: "ls" }, { label: "runs", command: `${app}gh run list --limit 8` }];
	assert.equal(checkToolCall("ctx_batch_execute", { commands }, env())?.reason, REASONS.ci);
	assert.equal(checkToolCall("read", { path: "/home/m/workspace/apps/keeb/x" }, env()), undefined);
});

// --- stalled turns ---

const user = { role: "user", content: "fix it" };
const edit = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "edit" }] };
const result = { role: "toolResult", content: [{ type: "text", text: "ok" }] };
const say = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
const nudge = { role: "custom", customType: NUDGE_TYPE, content: "..." };

test("an empty or short stop after an edit is nudged", () => {
	assert.equal(shouldNudge([user, edit, result, say("")]), true);
	assert.equal(shouldNudge([user, edit, result, say("Re-running the mutation test with the deferred version.")]), true);
});

test("real replies, questions and non-coding runs are left alone", () => {
	assert.equal(shouldNudge([user, edit, result, say("x".repeat(400))]), false);
	assert.equal(shouldNudge([user, edit, result, say("Merge PR #4 or keep the old colour?")]), false);
	const search = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "web_search" }] };
	assert.equal(shouldNudge([user, search, result, say("It's 14°C.")]), false);
	assert.equal(shouldNudge([user, say("Hi.")]), false);
});

test("nudges are capped per prompt and reset by the next user message", () => {
	const capped = [user, edit, result, ...Array(MAX_NUDGES).fill(0).flatMap(() => [say(""), nudge, edit, result]), say("")];
	assert.equal(shouldNudge(capped), false);
	assert.equal(shouldNudge([...capped, user, edit, result, say("")]), true);
});

test("a reply right after a nudge ends the run", () => {
	assert.equal(shouldNudge([user, edit, result, say(""), nudge, say("Done: PR #4 is green.")]), false);
});

test("discards spots commands that overwrite working-tree files", () => {
	for (const c of [
		"git checkout origin/main -- src/stats/stats.ts",
		"git checkout -- .",
		"git checkout HEAD -- src/a.ts src/b.ts && npm test",
		"git restore src/stats/stats.ts",
		"git restore --source=main --staged --worktree src/a.ts",
		"git reset --hard HEAD",
		"git -C ~/workspace/apps/keeb checkout main -- src/a.ts",
	]) assert.equal(discards(c), true, c);
	for (const c of ["git checkout main", "git checkout -b fix/x", "git switch main", "git restore --staged src/a.ts", "git show main:src/a.ts", "git reset --soft HEAD~1", "git diff -- src/a.ts"]) {
		assert.equal(discards(c), false, c);
	}
});

test("discarding is blocked only while the app has uncommitted changes", () => {
	const revert = `${app}git checkout origin/main -- src/stats/stats.ts && npx vitest run`;
	assert.equal(bash(revert), REASONS.discard);
	assert.equal(bash(revert, env({ dirty: () => false })), undefined);
	assert.equal(bash("cd ~/workspace/pi-web && git checkout -- ."), undefined);
});

// --- open to-dos at the end of a run ---

const todoEntry = (tasks: { id: number; subject: string; status: string }[]) => ({
	type: "message",
	message: { role: "toolResult", toolName: "todo", details: { tasks, nextId: tasks.length + 1 } },
});
const todoCall = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "todo" }] };
const long = say("Done: PR #16 is open and green. " + "x".repeat(400));
const todoNudgeMsg = { role: "custom", customType: TODO_NUDGE_TYPE, content: "..." };

test("openTodos reads the latest todo list on the branch and keeps in-progress and pending items", () => {
	const branch = [
		todoEntry([{ id: 1, subject: "a", status: "pending" }]),
		{ type: "message", message: { role: "toolResult", toolName: "bash", details: {} } },
		todoEntry([
			{ id: 1, subject: "a", status: "completed" },
			{ id: 2, subject: "b", status: "in_progress" },
			{ id: 3, subject: "c", status: "pending" },
			{ id: 4, subject: "d", status: "deleted" },
		]),
		{ type: "compaction" },
	];
	assert.deepEqual(openTodos(branch).map((t) => t.id), [2, 3]);
	assert.deepEqual(openTodos([]), []);
	assert.deepEqual(openTodos([{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: "junk" } } }]), []);
});

test("a finished coding run with open to-dos is sent back once per nudge, up to the cap", () => {
	const open = [{ id: 2, subject: "Make keeb pass knip", status: "in_progress" }];
	assert.equal(shouldNudgeTodos([user, edit, result, long], open), true);
	assert.equal(shouldNudgeTodos([user, todoCall, result, long], open), true);
	const capped = [user, edit, result, ...Array(MAX_TODO_NUDGES).fill(0).flatMap(() => [long, todoNudgeMsg]), long];
	assert.equal(shouldNudgeTodos(capped, open), false);
});

test("no to-do nudge when nothing is open, pi asks a question, or the run did no work", () => {
	const open = [{ id: 2, subject: "b", status: "pending" }];
	assert.equal(shouldNudgeTodos([user, edit, result, long], []), false);
	assert.equal(shouldNudgeTodos([user, edit, result, say("Merge PR #4 or keep the old colour?")], open), false);
	assert.equal(shouldNudgeTodos([user, say("Hi.")], open), false);
});

test("the to-do nudge names each open item and what to do", () => {
	const text = todoNudge([
		{ id: 2, subject: "Make keeb pass the guardrail tests", status: "in_progress" },
		{ id: 4, subject: "Make keeb e2e pass in parallel", status: "pending" },
	]);
	assert.match(text, /2 open items/);
	assert.match(text, /#2 Make keeb pass the guardrail tests \(in progress\)/);
	assert.match(text, /#4 Make keeb e2e pass in parallel \(pending\)/);
	assert.match(text, /completed/);
	assert.match(text, /delete/);
});

test("a short reply after tidying the to-do list is not treated as a stall", () => {
	const todoNudgeMsg2 = { role: "custom", customType: TODO_NUDGE_TYPE, content: "..." };
	assert.equal(shouldNudge([user, edit, result, long, todoNudgeMsg2, todoCall, result, say("Done, list updated.")]), false);
});

// --- pr and ship timeouts ---

test("pr and gateway-pr with any bash timeout are blocked; without one they pass", () => {
	const skill = "node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts";
	const pr = `${app}${skill} pr . --title "x" --body "y"`;
	const gpr = `${skill} gateway-pr ~/workspace/apps/keeb --title x --body y`;
	for (const command of [pr, gpr]) {
		for (const timeout of [30, 600, 2400]) assert.equal(checkToolCall("bash", { command, timeout }, env())?.reason, REASONS.prTimeout, `${timeout}`);
		assert.equal(checkToolCall("bash", { command }, env()), undefined);
	}
	assert.equal(checkToolCall("bash", { command: `${app}npm test`, timeout: 60 }, env()), undefined);
	assert.equal(checkToolCall("bash", { command: `${skill} check foo`, timeout: 60 }, env()), undefined);
});

const skillCmd = "node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts";
const waits = [`${skillCmd} pr-wait ~/workspace/apps/keeb`, `${skillCmd} gateway-pr-wait ~/workspace/apps/keeb`, `${skillCmd} ship ~/workspace/apps/keeb`];

test("pr-wait, gateway-pr-wait and ship in bash are blocked, with or without a timeout", () => {
	for (const command of waits) {
		assert.equal(checkToolCall("bash", { command }, env())?.reason, REASONS.waitInBackground, command);
		assert.equal(checkToolCall("bash", { command, timeout: 2400 }, env())?.reason, REASONS.waitInBackground, command);
	}
});

test("backgrounding them in bash is blocked too", () => {
	for (const command of [`nohup ${skillCmd} pr-wait ~/workspace/apps/keeb > /tmp/o 2>&1 &`, `${skillCmd} ship ~/workspace/apps/keeb &`, `setsid ${skillCmd} gateway-pr-wait ~/workspace/apps/keeb`]) {
		assert.equal(checkToolCall("bash", { command }, env())?.reason, REASONS.waitInBackground, command);
	}
});

test("bg_bash may run pr-wait, gateway-pr-wait and ship", () => {
	for (const command of waits) assert.equal(checkToolCall("bg_bash", { command }, env()), undefined, command);
});

test("pr-wait and gateway-pr-wait never hit the review gate; pr still does", () => {
	const unreviewed = { ...env(), reviewed: () => false, codeChanged: () => true };
	for (const sub of ["pr-wait", "gateway-pr-wait"]) {
		const command = `cd ~/workspace/apps/keeb && node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts ${sub} ~/workspace/apps/keeb`;
		assert.equal(checkToolCall("bg_bash", { command }, unreviewed), undefined, sub);
	}
	const pr = "cd ~/workspace/apps/keeb && node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr . --title x --body y";
	assert.equal(checkToolCall("bg_bash", { command: pr }, unreviewed)?.reason, REASONS.review);
});

test("bg_bash commands get the same shell checks as bash", () => {
	assert.equal(checkToolCall("bg_bash", { command: "cd ~/workspace/apps/x && git push" }, env())?.reason, REASONS.push);
});

// --- app changed, no PR ---

const editApp = (path: string) => ({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "edit", arguments: { path } }] });
const runPr = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: { command: "cd ~/workspace/apps/keeb && node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr . --title x --body y" } }] };
const prNudgeMsg = { role: "custom", customType: PR_NUDGE_TYPE, content: "..." };

test("appsNeedingPr lists apps edited in this run with no pr or ship after the last edit", () => {
	const needs = (d: string) => d.endsWith("/keeb");
	const keeb = editApp("/home/m/workspace/apps/keeb/src/app-main.ts");
	const tips = editApp("/home/m/workspace/apps/tips/src/x.ts");
	assert.deepEqual(appsNeedingPr([user, keeb, result, tips, result, long], home, needs), ["/home/m/workspace/apps/keeb"]);
	assert.deepEqual(appsNeedingPr([user, keeb, result, runPr, result, long], home, needs), []);
	assert.deepEqual(appsNeedingPr([user, runPr, result, keeb, result, long], home, needs), ["/home/m/workspace/apps/keeb"]);
	assert.deepEqual(appsNeedingPr([user, editApp("/home/m/workspace/pi-web/x.ts"), result, long], home, () => true), []);
	// Only this prompt's run counts.
	assert.deepEqual(appsNeedingPr([user, keeb, result, long, user, say("thanks")], home, needs), []);
});

test("a finished run that left an app without a PR is nudged, up to the cap; questions are not", () => {
	const apps = ["/home/m/workspace/apps/keeb"];
	assert.equal(shouldNudgePr([user, long], apps), true);
	assert.equal(shouldNudgePr([user, say("Open the PR now, or keep going?")], apps), false);
	assert.equal(shouldNudgePr([user, long], []), false);
	assert.equal(shouldNudgePr([user, long, prNudgeMsg, long, prNudgeMsg, long], apps), false);
	const text = prNudge(apps);
	assert.match(text, /keeb/);
	assert.match(text, /thatsit-app\.ts pr ~\/workspace\/apps\/keeb/);
	assert.doesNotMatch(text, /2400|timeout/);
	assert.match(text, /pr-wait/);
	assert.match(text, /bg_bash/);
	assert.match(text, /git switch -c/);
});

// --- review before PR ---

const userMsg = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const subCall = (id: string, args: Record<string, unknown>, text = "") => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }, { type: "toolCall", id, name: "subagent", arguments: args }] },
});
const toolRes = (id: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, isError, content: [] } });

test("reviewedSinceUser: a reviewer that returned after Michael's last message counts", () => {
	assert.equal(reviewedSinceUser([userMsg("fix it"), subCall("a", { agent: "reviewer", task: "review", async: false }), toolRes("a")]), true);
	assert.equal(reviewedSinceUser([userMsg("fix it"), subCall("a", { agent: "reviewer", task: "review" }), toolRes("a")]), false, "background run: only a receipt");
	assert.equal(reviewedSinceUser([userMsg("fix it"), subCall("a", { agent: "reviewer", task: "review", async: false }), toolRes("a", true)]), false, "failed review");
	assert.equal(reviewedSinceUser([userMsg("fix it"), subCall("a", { agent: "scout", task: "look" }), toolRes("a")]), false, "not a reviewer");
	assert.equal(reviewedSinceUser([userMsg("fix it"), subCall("a", { agent: "reviewer", async: false }), toolRes("a"), userMsg("now this")]), false, "before the last message");
	assert.equal(reviewedSinceUser([userMsg("fix it"), subCall("a", { workflow: true, async: false }, 'return runs.run("r", { agent: "reviewer", task: "x" })'), toolRes("a")]), true, "inside a workflow");
	assert.equal(reviewedSinceUser([]), false);
});

test("pr and gateway-pr are blocked until a reviewer ran, unless only docs, Markdown or CI changed", () => {
	const pr = "cd ~/workspace/apps/keeb && node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/keeb --title t --body b";
	const base = { cwd: "/home/m", home: "/home/m", hasScript: () => false, dirty: () => false };
	assert.deepEqual(checkShell(pr, { ...base, reviewed: () => false, codeChanged: () => true }), { block: true, reason: REASONS.review });
	assert.deepEqual(checkShell(pr.replace(" pr ", " gateway-pr "), { ...base, reviewed: () => false, codeChanged: () => true }), { block: true, reason: REASONS.review });
	assert.equal(checkShell(pr, { ...base, reviewed: () => true, codeChanged: () => true }), undefined);
	assert.equal(checkShell(pr, { ...base, reviewed: () => false, codeChanged: () => false }), undefined);
	assert.equal(checkShell(pr.replace(" pr ", " ship "), { ...base, reviewed: () => false, codeChanged: () => true }), undefined, "ship is the first version");
});

test("reviewFree: docs, Markdown and CI files only", () => {
	for (const f of ["docs/spec.md", "README.md", "AGENTS.md", ".github/workflows/deploy.yml"]) assert.equal(reviewFree(f), true, f);
	for (const f of ["src/app-main.ts", "test/a.test.ts", "package.json", "e2e/x.spec.ts"]) assert.equal(reviewFree(f), false, f);
});

// --- whole-file rewrites ---

test("a write over an existing app file of more than 80 lines is blocked once, then allowed", () => {
	const rewrites = new Set<string>();
	const lines = (p: string) => (p.endsWith("big.ts") ? 200 : p.endsWith("small.ts") ? 20 : undefined);
	const e = env({ lines, rewrites });
	const big = `${home}/workspace/apps/keeb/src/big.ts`;
	assert.deepEqual(checkToolCall("write", { path: big, content: "x" }, e), { block: true, reason: REASONS.overwrite });
	assert.equal(checkToolCall("write", { path: big, content: "x" }, e), undefined, "second try: Michael's agent means it");
	assert.equal(checkToolCall("write", { path: `${home}/workspace/apps/keeb/src/small.ts`, content: "x" }, e), undefined, "short file");
	assert.equal(checkToolCall("write", { path: `${home}/workspace/apps/keeb/src/new.ts`, content: "x" }, e), undefined, "new file");
	assert.equal(checkToolCall("write", { path: `${home}/notes/big.ts`, content: "x" }, e), undefined, "not an app");
	assert.deepEqual(checkToolCall("write", { path: "~/workspace/apps/keeb/docs/big.ts", content: "x" }, env({ lines, rewrites: new Set() })), { block: true, reason: REASONS.overwrite }, "~ path");
	assert.deepEqual(checkToolCall("write", { path: "src/big.ts", content: "x" }, env({ cwd: `${home}/workspace/apps/keeb`, lines, rewrites: new Set() })), { block: true, reason: REASONS.overwrite }, "relative path");
	assert.equal(checkToolCall("write", { path: big, content: "x" }, env()), undefined, "no line counter: not checked");
});
