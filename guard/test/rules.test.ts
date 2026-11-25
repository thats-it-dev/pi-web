import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exhaustedRun, planRewrite, kitPatterns, kitPatternIds, kitDepartures, kitPatternNote, absPath, branchRequests, discardOrder, inheritedChanges, inheritedNote, shipOverride, previewOpened, previewNote, PREVIEW_NOTE_MARK, busyWorker, checkShell, defaultRunDir, defaultRunText, designDoc, lastBlockedReview, lastRequest, reviewBlocked, reviewBlockedMark, reviewGap, REVIEW_PENDING_MARK, reviewVerdict, indirectReviewer, lastReview, noteWithdrawn, promptDigest, REVIEW_BUDGET, reviewApp, reviewedSinceUser, reviewFree, reviewHeader, reviewMark, screenCompareContent, userPictures, verifiedSinceEdit, withdrawnFollowUps, withdrawnNote, workerBusy, WORKTREE, workspacePath, reposNeedingPr, repoPrNudge, appCodePath } from "../rules.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appDir, appsNeedingPr, asyncRunId, defaultRunState, pairSettings, partialAnswers, checkToolCall, PR_NUDGE_TYPE, prNudge, reviewPendingMark, shouldNudgePr, discards, fullE2e, MAX_NUDGES, MAX_TODO_NUDGES, MERGE_NUDGE_TYPE, shouldNudgeMerge, suggestsMerge, NUDGE_TYPE, openTodos, REASONS, shouldNudge, shouldNudgeTodos, TODO_NUDGE_TYPE, todoNudge, type Env, type RunState } from "../rules.ts";

const home = "/home/m";
const env = (over: Partial<Env> = {}): Env => ({ cwd: home, home, hasScript: () => true, dirty: () => true, ...over });
const bash = (command: string, e = env()) => checkToolCall("bash", { command }, e)?.reason;
const app = "cd ~/workspace/apps/keeb && ";

test("appDir finds the app from the command or the cwd", () => {
	assert.equal(appDir("cd ~/workspace/apps/keeb && ls", home, home), "/home/m/workspace/apps/keeb");
	assert.equal(appDir("git -C $HOME/workspace/apps/tips status", home, home), "/home/m/workspace/apps/tips");
	assert.equal(appDir("ls", "/home/m/workspace/apps/keeb/src", home), "/home/m/workspace/apps/keeb");
	assert.equal(appDir("cd ~/workspace/pi-web && git push", home, home), undefined);
	// pi-subagents worktrees live beside the apps: governed as the app they were cut from.
	assert.equal(appDir("cd ~/workspace/apps/worktrees/cad/pi-worktree-ab12-0 && npm test", home, home), "/home/m/workspace/apps/cad");
	assert.equal(appDir("npm test", "/home/m/workspace/apps/worktrees/cad/pi-worktree-ab12-0/src", home), "/home/m/workspace/apps/cad");
	assert.equal(appDir("ls", "/home/m/workspace/apps/worktrees", home), undefined);
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

test("Python file rewrites in an app are blocked", () => {
	const py = `${app}python3 - <<'PY'\np="src/app-main.ts"; s=open(p).read()\nopen(p,"w").write(s.replace("a","b"))\nPY`;
	assert.equal(bash(py), REASONS.rewrite);
	assert.equal(bash(`${app}python3 -c 'print(open("src/x.ts").read())'`), undefined);
	// A scratch file in /tmp, even when the script mentions the app.
	assert.equal(bash(`cd /tmp && python3 - <<'PY'\nopen("m3check.cjs","w").write("~/workspace/apps/keeb")\nPY`), undefined);
});

test("only bash and bg_bash carry shell for the rules; other tools pass", () => {
	assert.equal(checkToolCall("bg_bash", { command: `${app}sleep 420` }, env())?.reason, REASONS.ci);
	assert.equal(checkToolCall("ctx_execute", { language: "shell", code: `${app}sleep 420` }, env()), undefined, "context-mode is gone (2026-11-25)");
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

const marked = (id: string, dir = "/home/m/workspace/apps/keeb", snap = "abc1234", isError = false) => ({
	type: "message",
	message: { role: "toolResult", toolCallId: id, isError, content: [{ type: "text", text: "## Review\nNo issues found." }, { type: "text", text: reviewMark(dir, snap) }] },
});

test("reviewedSinceUser: only a review the guard scoped and marked, after Michael's last message, counts", () => {
	assert.equal(reviewedSinceUser([userMsg("fix it"), subCall("a", { agent: "reviewer", task: "review" }), marked("a")]), true);
	assert.equal(reviewedSinceUser([userMsg("fix it"), subCall("a", { agent: "reviewer", task: "review", async: false }), toolRes("a")]), false, "unscoped: no mark");
	assert.equal(reviewedSinceUser([userMsg("fix it"), marked("a", undefined, undefined, true)]), false, "failed review");
	assert.equal(reviewedSinceUser([userMsg("fix it"), marked("a"), userMsg("now this")]), false, "before the last message");
	assert.equal(reviewedSinceUser([]), false);
});

test("lastReview: the snapshot of the newest mark for that app", () => {
	const keeb = "/home/m/workspace/apps/keeb";
	const branch = [marked("a", keeb, "aaaaaaa"), marked("b", "/home/m/workspace/apps/tips", "bbbbbbb"), userMsg("x"), marked("c", keeb, "ccccccc"), marked("d", keeb, "ddddddd", true)];
	assert.equal(lastReview(branch, keeb), "ccccccc");
	assert.equal(lastReview(branch, "/home/m/workspace/apps/tips"), "bbbbbbb");
	assert.equal(lastReview(branch, "/home/m/workspace/apps/other"), undefined);
});

test("reviewApp: an apps path in the task, then the diff file name, then the cwd", () => {
	assert.equal(reviewApp("Review ~/workspace/apps/keeb for X", home, home), "/home/m/workspace/apps/keeb");
	assert.equal(reviewApp("Review /tmp/touchtype-review.diff", home, home, () => true), "/home/m/workspace/apps/touchtype");
	assert.equal(reviewApp("Review /tmp/website-next-review.diff", home, home, () => false), undefined, "a diff named for a repo outside apps is not an app");
	assert.equal(reviewApp("Review it", "/home/m/workspace/apps/tips/src", home), "/home/m/workspace/apps/tips");
	assert.equal(reviewApp("Review the plan", home, home), undefined);
});

test("indirectReviewer: a reviewer inside a workflow, chain or task list", () => {
	assert.equal(indirectReviewer({ workflow: true, script: 'runs.run("r", { agent: "reviewer" })' }), true);
	assert.equal(indirectReviewer({ chain: [{ agent: "reviewer", task: "x" }] }), true);
	assert.equal(indirectReviewer({ tasks: [{ agent: "scout", task: "x" }] }), false);
	assert.equal(indirectReviewer({ agent: "reviewer", task: "x" }), false);
	assert.equal(indirectReviewer({ action: "list" }), false);
});

test("verifiedSinceEdit: a green verify in the app after the last code edit; docs edits don't count", () => {
	const keeb = "/home/m/workspace/apps/keeb";
	const edit = (id: string, path: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "edit", arguments: { path } }] } });
	const verify = (id: string, command = "cd ~/workspace/apps/keeb && npm run verify") => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] } });
	const v = (b: unknown[]) => verifiedSinceEdit(b, keeb, home, home);
	assert.equal(v([edit("e", `${keeb}/src/a.ts`), verify("v"), toolRes("v")]), true);
	assert.equal(v([edit("e", `${keeb}/src/a.ts`), verify("v"), toolRes("v", true)]), false, "verify failed");
	assert.equal(v([verify("v"), toolRes("v"), edit("e", `${keeb}/src/a.ts`)]), false, "code edited after verify");
	assert.equal(v([verify("v"), toolRes("v"), edit("e", `${keeb}/docs/spec.md`)]), true, "docs edit after verify");
	assert.equal(v([edit("e", `${keeb}/src/a.ts`), verify("v", "cd ~/workspace/apps/tips && npm run verify"), toolRes("v")]), false, "another app");
	assert.equal(v([edit("e", `${keeb}/src/a.ts`)]), false, "never verified");
});

test("reviewHeader names the scope, the verify result and the budget", () => {
	const h = reviewHeader({ dir: "/home/m/workspace/apps/keeb", base: "0123456789ab", baseFrom: "review", diffPath: "/tmp/keeb-review.diff", files: [{ path: "src/a.ts", added: "3", removed: "1" }] });
	assert.match(h, /- src\/a\.ts \(\+3 -1\)/);
	assert.match(h, /already reviewed/);
	assert.match(h, /npm run verify/);
	assert.match(h, new RegExp(`${REVIEW_BUDGET.hard} tool calls`));
	assert.doesNotMatch(h, /Michael's request/);
	const withReq = reviewHeader({ dir: "/home/m/workspace/apps/keeb", base: "0123456789ab", baseFrom: "main", diffPath: "/tmp/keeb-review.diff", files: [], request: "space and enter switch layers instead of typing" });
	assert.match(withReq, /\[Michael's messages on this branch, verbatim[^\]]*\]\nspace and enter switch layers instead of typing\n/);
	assert.match(withReq, /A named behavior with no such test is a P1 finding and the merge verdict is BLOCK/);
	assert.ok(withReq.indexOf("Michael's messages") < withReq.indexOf("[The parent's request]"), "Michael's words come before the parent's summary");
});

test("lastRequest: Michael's last message on the branch, verbatim, text parts only, cut when long", () => {
	const user = (content: unknown) => ({ type: "message", message: { role: "user", content } });
	const tool = { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x" }] } };
	assert.equal(lastRequest([]), undefined);
	assert.equal(lastRequest([user("first"), tool, user("  second\nline  "), tool]), "second\nline");
	assert.equal(lastRequest([user([{ type: "text", text: "look" }, { type: "image", data: "AAA", mimeType: "image/png" }])]), "look");
	assert.equal(lastRequest([user("real"), user("   ")]), "real", "an empty message does not replace the last real one");
	const long = lastRequest([user("a".repeat(50))], 10);
	assert.equal(long, `${"a".repeat(10)}\n[cut at 10 characters]`);
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

// --- background jobs ---

const bgCall = (command: string) => ({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bg_bash", arguments: { command } }] });
const bgStarted = (id: string) => ({ role: "toolResult", toolName: "bg_bash", content: [{ type: "text", text: `started job ${id}. You will get a bg-bash-done message when it exits; end your turn and wait.` }], details: { id } });
const bgDone = (id: string) => ({ role: "custom", customType: "bg-bash-done", content: `bg_bash job ${id} exited 1 after 2m 3s: pr-wait\nchecks failed` });
const prWait = `cd ~/workspace/apps/keeb && ${skillCmd} pr-wait .`;

test("no end-of-turn nudge while a bg_bash job of the run has not reported back", () => {
	const waiting = [user, editApp("/home/m/workspace/apps/keeb/src/x.ts"), result, runPr, result, bgCall(prWait), bgStarted("bg-1"), say("PR #4 is open; CI is running.")];
	assert.equal(shouldNudge(waiting), false);
	assert.equal(shouldNudgeTodos(waiting, [{ id: 1, subject: "wait for CI", status: "in_progress" }]), false);
	assert.equal(shouldNudgePr(waiting, ["/home/m/workspace/apps/keeb"]), false);
	// The job id from details when the text has none.
	const bare = { ...bgStarted("bg-2"), content: [{ type: "text", text: "started" }] };
	assert.equal(shouldNudge([user, edit, result, bgCall(prWait), bare, say("CI is running.")]), false);
});

test("nudges come back once the job's bg-bash-done message arrived", () => {
	const after = [user, edit, result, bgCall(prWait), bgStarted("bg-1"), say("CI is running."), bgDone("bg-1"), edit, result, say("")];
	assert.equal(shouldNudge(after), true);
	assert.equal(shouldNudgeTodos(after, [{ id: 1, subject: "fix CI", status: "in_progress" }]), true);
	assert.equal(shouldNudgePr(after, ["/home/m/workspace/apps/keeb"]), true);
	// Another job's done message does not count.
	assert.equal(shouldNudge([user, edit, result, bgCall(prWait), bgStarted("bg-2"), bgDone("bg-1"), say("")]), false);
});

test("a ship or pr run through bg_bash counts as the PR; pr-wait alone does not", () => {
	const keeb = editApp("/home/m/workspace/apps/keeb/src/app-main.ts");
	assert.deepEqual(appsNeedingPr([user, keeb, result, bgCall(`${skillCmd} ship ~/workspace/apps/keeb`), bgStarted("bg-1"), long], home, () => true), []);
	assert.deepEqual(appsNeedingPr([user, keeb, result, bgCall(prWait), bgStarted("bg-1"), long], home, () => true), ["/home/m/workspace/apps/keeb"]);
});

test("push and CI reasons send CI waits through bg_bash and rerun the same pr command", () => {
	for (const r of [REASONS.push, REASONS.ci]) {
		assert.match(r, /bg_bash/);
		assert.match(r, /pr-wait/);
		assert.doesNotMatch(r, /`pr` and `ship` already wait|pushes, waits for CI/);
	}
	assert.match(REASONS.ci, /rerun the same `pr` command/);
});

test("a reply that asks mid-text and ends with a TL;DR line is waiting on Michael: no nudges", () => {
	const open = [{ id: 1, subject: "Brainstorm the design", status: "in_progress" }];
	const asked = say(
		"Route 2 locked.\n\n**Question 1 — what is the last part you wanted to print?** Describe it as concretely as you can.\n\nWhy I'm asking: it changes the sketch model.\n\nTL;DR: route confirmed; now need the part you want to print.",
	);
	assert.equal(shouldNudgeTodos([user, todoCall, result, asked], open), false);
	assert.equal(shouldNudge([user, edit, result, say("Which colour, red or blue?\n\nTL;DR: waiting on the colour.")]), false);
	// A question inside a code block or a quote is not asking Michael anything.
	const quoted = say("Done: the guard now handles it.\n\n```\nif (x?) y\n```\n> was it red?\n\nTL;DR: guard fixed.");
	assert.equal(shouldNudgeTodos([user, todoCall, result, quoted], open), true);
});

test("a cancelled questionnaire still hands the model the answers Michael gave", () => {
	const input = { questions: [{ question: "How should parts live?" }, { question: "How to start a part?" }, { question: "Real parts?" }, { question: "Export?" }] };
	const details = {
		cancelled: true,
		answers: [
			{ questionIndex: 0, question: "How should parts live?", kind: "option", answer: "Separate bodies in one file (Recommended)" },
			{ questionIndex: 1, question: "How to start a part?", kind: "custom", answer: "Take heavy inspiration from shapr3d" },
		],
	};
	const text = partialAnswers(input, details);
	assert.ok(text);
	assert.match(text, /answered 2 of 4/);
	assert.match(text, /"How should parts live\?"="Separate bodies in one file \(Recommended\)"/);
	assert.match(text, /"How to start a part\?"="Take heavy inspiration from shapr3d"/);
	assert.match(text, /Real parts\?/);
	assert.match(text, /not .*preference/i);
	// Multi-select answers list what was picked.
	const multi = { cancelled: true, answers: [{ questionIndex: 0, question: "Q", kind: "multi", answer: null, selected: ["A", "C"] }] };
	assert.match(partialAnswers({ questions: [{ question: "Q" }, { question: "R" }] }, multi) ?? "", /"Q"="A, C"/);
	// A plain decline, or an answered questionnaire, is left as it is.
	assert.equal(partialAnswers(input, { cancelled: true, answers: [] }), undefined);
	assert.equal(partialAnswers(input, { cancelled: false, answers: details.answers }), undefined);
	assert.equal(partialAnswers(input, undefined), undefined);
});

test("a pending review counts only once its run is complete, and the latest complete one sets the base", () => {
	const dir = "/home/m/workspace/apps/keeb";
	const res = (text: string) => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } });
	const branch = [{ type: "message", message: { role: "user", content: "go" } }, res(reviewPendingMark(dir, "aaaaaaa", "run-a")), res(reviewPendingMark(dir, "bbbbbbb", "run-b"))];
	const states: Record<string, ReturnType<RunState>> = { "run-a": "complete", "run-b": "running" };
	const runState: RunState = (id) => states[id] ?? "missing";
	const verdict = () => "No issues found.";
	assert.equal(reviewedSinceUser(branch, runState, verdict), true);
	assert.equal(lastReview(branch, dir, runState, verdict), "aaaaaaa");
	states["run-b"] = "complete";
	assert.equal(lastReview(branch, dir, runState, verdict), "bbbbbbb");
	assert.equal(reviewedSinceUser(branch, () => "missing", verdict), false);
	assert.equal(reviewedSinceUser(branch, () => "failed", verdict), false);
});

test("asyncRunId reads the run id from an async launch result", () => {
	assert.equal(asyncRunId("Run fan-out: 1/64 used\nAsync: reviewer [0bdd2a04-7e76-4cca-8c02-1ad3fb71d86b]\n"), "0bdd2a04-7e76-4cca-8c02-1ad3fb71d86b");
	assert.equal(asyncRunId("Async: worker [0bdd2a04-7e76-4cca-8c02-1ad3fb71d86b]"), undefined);
});

test("defaultRunState reads a run's status.json under the given root: complete, partial, failed, missing", () => {
	const root = mkdtempSync(join(tmpdir(), "guard-runs-"));
	const put = (id: string, body: string) => {
		mkdirSync(join(root, id), { recursive: true });
		writeFileSync(join(root, id, "status.json"), body);
	};
	put("done", JSON.stringify({ state: "complete" }));
	put("part", JSON.stringify({ state: "partial" }));
	put("bad", JSON.stringify({ state: "failed" }));
	put("junk", "{not json");
	assert.equal(defaultRunState("done", root), "complete");
	assert.equal(defaultRunState("part", root), "running");
	assert.equal(defaultRunState("bad", root), "failed");
	assert.equal(defaultRunState("junk", root), "missing");
	assert.equal(defaultRunState("never", root), "missing");
	assert.equal(defaultRunState("done", join(root, "gone")), "missing");
});

test("appDir drops the sentence punctuation after an app path (keeb run 2026-11-12: 'in …/apps/touchtype.' made a dir that does not exist)", () => {
	assert.equal(appDir("Review the changes on branch feat/x in /home/m/workspace/apps/keeb.\n\n1. Read the spec", home, home), "/home/m/workspace/apps/keeb");
	assert.equal(appDir("see /home/m/workspace/apps/keeb.", home, home), "/home/m/workspace/apps/keeb");
	assert.equal(appDir("see /home/m/workspace/apps/worktrees/keeb/pi-worktree-ab12-0.", home, home), "/home/m/workspace/apps/keeb");
	assert.equal(appDir("see /home/m/workspace/apps/my.app/src", home, home), "/home/m/workspace/apps/my.app");
});

test("installing packages inside a pi-subagents worktree is blocked: its node_modules is a symlink to the main checkout's", () => {
	const wt = "cd ~/workspace/apps/worktrees/keeb/pi-worktree-ab12-0 && ";
	assert.equal(bash(`${wt}npm ci`), REASONS.worktreeInstall);
	assert.equal(bash(`${wt}npm ci 2>&1 | tail -5`), REASONS.worktreeInstall);
	assert.equal(bash(`${wt}npm install`), REASONS.worktreeInstall);
	assert.equal(bash(`${wt}npm i -D vitest`), REASONS.worktreeInstall);
	assert.equal(bash(`${wt}pnpm install`), REASONS.worktreeInstall);
	assert.equal(bash("npm ci", env({ cwd: "/home/m/workspace/apps/worktrees/keeb/pi-worktree-ab12-0" })), REASONS.worktreeInstall);
	assert.equal(bash(`${wt}npm run typecheck && npm test`), undefined);
	assert.equal(bash(`${app}npm ci`), undefined);
	assert.equal(bash("npm ci", env({ cwd: "/home/m/workspace/apps/keeb" })), undefined);
});

test("the orchestrator of the agent pair never edits app code itself; docs, plans and briefs are fine", () => {
	const o = env({ orchestrator: true });
	const code = "/home/m/workspace/apps/keeb/src/ui/card.ts";
	assert.equal(checkToolCall("edit", { path: code, edits: [] }, o)?.reason, REASONS.orchestrator);
	assert.equal(checkToolCall("write", { path: "/home/m/workspace/apps/keeb/e2e/daily.spec.ts", content: "" }, o)?.reason, REASONS.orchestrator);
	assert.equal(checkToolCall("write", { path: "~/workspace/apps/keeb/package.json", content: "" }, o)?.reason, REASONS.orchestrator);
	assert.equal(checkToolCall("edit", { path: "/home/m/workspace/apps/worktrees/keeb/pi-worktree-ab12-0/src/a.ts", edits: [] }, o)?.reason, REASONS.orchestrator);
	assert.equal(checkToolCall("edit", { path: "/home/m/workspace/apps/keeb/docs/superpowers/plans/2026-11-12-x.md", edits: [] }, o), undefined);
	assert.equal(checkToolCall("write", { path: "/home/m/workspace/apps/keeb/.superpowers/sdd/x/task-1-brief.md", content: "" }, o), undefined);
	assert.equal(checkToolCall("edit", { path: "/home/m/workspace/apps/keeb/README.md", edits: [] }, o), undefined);
	// Any other repo under ~/workspace is the workers' too (2026-11-18); outside workspace nothing applies.
	assert.equal(checkToolCall("edit", { path: "/home/m/workspace/pi-web/guard/rules.ts", edits: [] }, o)?.reason, REASONS.orchestrator);
	assert.equal(checkToolCall("edit", { path: "/home/m/elsewhere/rules.ts", edits: [] }, o), undefined);
	// Shell writes to app code count too; running, merging and committing do not.
	assert.equal(bash(`${app}sed -i 's/a/b/' src/ui/card.ts`, o), REASONS.orchestrator);
	assert.equal(bash("rm /home/m/workspace/apps/keeb/src/ui/card.ts", o), REASONS.orchestrator);
	assert.equal(bash(`${app}cat > e2e/daily.spec.ts <<'EOF'\nx\nEOF`, o), REASONS.orchestrator);
	assert.equal(bash(`${app}git checkout 6339a62 -- src/stats/history-section.ts`, env({ orchestrator: true, dirty: () => false })), REASONS.orchestrator);
	assert.equal(bash(`${app}npm run verify`, o), undefined);
	assert.equal(bash(`${app}git merge 6339a62 && git commit -m "merge"`, o), undefined);
	assert.equal(bash(`${app}npm run verify > /tmp/verify.log 2>&1; tail -20 /tmp/verify.log`, o), undefined);
	assert.equal(bash(`${app}sed -i 's/- \\[ \\]/- [x]/' docs/superpowers/plans/x.md`, o), undefined);
	// Not the orchestrator (inline mode, or a worker child): the edit tool is free, and a shell rewrite is the rewrite rule's.
	assert.equal(checkToolCall("edit", { path: code, edits: [] }, env())?.reason, undefined);
	assert.equal(bash(`${app}sed -i 's/a/b/' src/ui/card.ts`), REASONS.rewrite);
});

test("pairSettings reads the pair from pi's settings, or the orchestrate flag on any models", () => {
	assert.equal(pairSettings({ defaultModel: "spark/pair-auto", subagents: { defaultModel: "spark/qwen3.6-35b-a3b-sglang" } }), true);
	assert.equal(pairSettings({ defaultModel: "spark/flash-auto", subagents: { defaultModel: "spark/qwen3.6-35b-a3b-sglang" } }), false);
	assert.equal(pairSettings(undefined), false);
	// 2026-11-24: delegation decoupled from the model pair, which was unloaded on 11-17 and took the workers with it.
	assert.equal(pairSettings({ defaultModel: "spark/flash-auto", subagents: { defaultModel: "spark/qwen3.8-flash-next", orchestrate: true } }), true);
	assert.equal(pairSettings({ defaultModel: "spark/flash-auto", subagents: { defaultModel: "spark/qwen3.8-flash-next", orchestrate: false } }), false);
	assert.equal(pairSettings({ defaultModel: "spark/pair-auto", subagents: { defaultModel: "spark/qwen3.6-35b-a3b-sglang", orchestrate: false } }), false, "the flag, when set, decides");
	assert.equal(pairSettings({ subagents: { orchestrate: "yes" } }), false, "a boolean, nothing else");
});

test("a reviewer run that stopped on the output cap is failed, never complete", () => {
	const root = mkdtempSync(join(tmpdir(), "runs-"));
	mkdirSync(join(root, "r1"));
	writeFileSync(join(root, "r1", "status.json"), JSON.stringify({ state: "failed", error: 'Subagent produced no output after terminal assistant stopReason "length".' }));
	assert.equal(defaultRunState("r1", root), "failed");
});

// A worker launch as pi-subagents records it on the branch: the call, then its launch result naming the run.
const launch = (call: string, run: string, args: Record<string, unknown>) => [
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: call, name: "subagent", arguments: args }] } },
	{ type: "message", message: { role: "toolResult", toolCallId: call, content: [{ type: "text", text: `Run fan-out: 1/64 used, 63 remaining\nAsync: ${args.agent} [${run}]\n\nThe async run is detached and running in the background.` }] } },
];
const RUN_A = "8c2c7de4-3280-4548-87ad-1dc153a27369";
const RUN_B = "1a11c8f0-30dc-467d-b866-69ff1e82638d";
const keebTask = "Work in /home/michael/workspace/apps/keeb on branch feat/x (already checked out). Read the brief first.";

test("verify and e2e wait while an async worker is still in the app's main checkout (keeb run 2026-11-12: a port clash and a commit with no e2e pass)", () => {
	const state = (states: Record<string, ReturnType<RunState>>): RunState => (id) => states[id] ?? "missing";
	const home = "/home/michael";
	const busyEnv = (branch: unknown[], states: Record<string, ReturnType<RunState>>) =>
		env({ home, cwd: home, busy: (dir) => busyWorker(branch, dir, home, home, state(states)) });
	const app = "cd ~/workspace/apps/keeb && ";
	const running = launch("c1", RUN_A, { agent: "worker", task: keebTask, async: true });
	assert.equal(bash(`${app}npm run verify 2>&1 | tail -40`, busyEnv(running, { [RUN_A]: "running" })), workerBusy(RUN_A));
	assert.equal(bash(`${app}npm run e2e:one -- e2e/daily.spec.ts`, busyEnv(running, { [RUN_A]: "running" })), workerBusy(RUN_A));
	assert.equal(bash(`${app}npx playwright test e2e/daily.spec.ts --project=desktop`, busyEnv(running, { [RUN_A]: "running" })), workerBusy(RUN_A));
	assert.equal(checkToolCall("bg_bash", { command: `${app}npm run verify` }, busyEnv(running, { [RUN_A]: "running" }))?.reason, workerBusy(RUN_A));
	// Reading the checkout is fine; so is another app.
	assert.equal(bash(`${app}git status --short && git diff`, busyEnv(running, { [RUN_A]: "running" })), undefined);
	assert.equal(bash("cd ~/workspace/apps/tips && npm run verify", busyEnv(running, { [RUN_A]: "running" })), undefined);
	// Once the run ends (or its dir aged out), verify runs.
	assert.equal(bash(`${app}npm run verify`, busyEnv(running, { [RUN_A]: "complete" })), undefined);
	assert.equal(bash(`${app}npm run verify`, busyEnv(running, {})), undefined);
	// A worktree worker works elsewhere; scouts and reviewers don't write.
	assert.equal(bash(`${app}npm run verify`, busyEnv(launch("c1", RUN_A, { agent: "worker", task: keebTask, async: true, worktree: true }), { [RUN_A]: "running" })), undefined);
	assert.equal(bash(`${app}npm run verify`, busyEnv(launch("c1", RUN_A, { agent: "reviewer", task: keebTask, async: true }), { [RUN_A]: "running" })), undefined);
	// The app can come from the call's cwd instead of the task text.
	const byCwd = launch("c1", RUN_A, { agent: "worker", task: "Read the brief at .superpowers/sdd/x/task-1-brief.md", cwd: "/home/michael/workspace/apps/keeb", async: true });
	assert.equal(bash(`${app}npm run verify`, busyEnv(byCwd, { [RUN_A]: "running" })), workerBusy(RUN_A));
	// A launch that names no app is tracked too: the run's status.json says where the worker works (its cwd, or the
	// paths in its tool calls). Until it has shown, it holds every checkout; in a worktree it holds none.
	const unnamed = launch("c1", RUN_A, { agent: "worker", task: "Read the brief at .superpowers/sdd/x/task-1-brief.md and follow it.", async: true });
	const root = mkdtempSync(join(tmpdir(), "runs-"));
	mkdirSync(join(root, RUN_A));
	const status = (s: object) => writeFileSync(join(root, RUN_A, "status.json"), JSON.stringify({ state: "running", cwd: "/home/michael", ...s }));
	const unnamedEnv = () => env({ home, cwd: home, busy: (dir) => busyWorker(unnamed, dir, home, home, state({ [RUN_A]: "running" }), (id) => defaultRunDir(id, home, root)) });
	status({ steps: [{ recentTools: [{ tool: "read", args: "/home/michael/workspace/apps/keeb/.superpowers/sdd/x/task-1-brief.md" }, { tool: "edit", args: "/home/michael/workspace/apps/keeb/src/a.ts" }] }] });
	assert.equal(bash(`${app}npm run verify`, unnamedEnv()), workerBusy(RUN_A));
	assert.equal(bash("cd ~/workspace/apps/tips && npm run verify", unnamedEnv()), undefined);
	status({ steps: [{ recentTools: [{ tool: "bash", args: "cd /home/michael/workspace/apps/keeb && npm test" }] }] });
	assert.equal(bash(`${app}npm run verify`, unnamedEnv()), workerBusy(RUN_A));
	status({ cwd: "/home/michael/workspace/apps/keeb", steps: [{ recentTools: [] }] });
	assert.equal(bash(`${app}npm run verify`, unnamedEnv()), workerBusy(RUN_A));
	status({ steps: [{ recentTools: [] }] });
	assert.equal(bash(`${app}npm run verify`, unnamedEnv()), workerBusy(RUN_A), "not shown yet: holds every checkout");
	assert.equal(bash("cd ~/workspace/apps/tips && npm run verify", unnamedEnv()), workerBusy(RUN_A));
	status({ steps: [{ recentTools: [{ tool: "edit", args: "/home/michael/workspace/apps/worktrees/keeb/pi-worktree-ab12-0/src/a.ts" }] }] });
	assert.equal(bash(`${app}npm run verify`, unnamedEnv()), undefined, "a worktree worker holds no main checkout");
	assert.equal(defaultRunDir(RUN_A, home, root), WORKTREE);
	// A worktree run's cwd is the app it was cut from; its tool calls tell the truth.
	status({ cwd: "/home/michael/workspace/apps/keeb", steps: [{ recentTools: [{ tool: "read", args: "/home/michael/workspace/apps/keeb/docs/spec.md" }, { tool: "edit", args: "/home/michael/workspace/apps/worktrees/keeb/pi-worktree-ab12-0/src/a.ts" }] }] });
	assert.equal(defaultRunDir(RUN_A, home, root), WORKTREE);
	assert.equal(defaultRunDir("no-such-run", home, root), undefined);
	// A resume revives the run under a new id, which inherits the checkout.
	const revived = [
		...running,
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "subagent", arguments: { action: "resume", id: RUN_A.slice(0, 8), message: "fix the selector" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "c2", content: [{ type: "text", text: `Revived async subagent from ${RUN_A}.\nRevived run: ${RUN_B}\nAgent: worker` }] } },
	];
	assert.equal(bash(`${app}npm run verify`, busyEnv(revived, { [RUN_A]: "complete", [RUN_B]: "running" })), workerBusy(RUN_B));
	assert.equal(bash(`${app}npm run verify`, busyEnv(revived, { [RUN_A]: "complete", [RUN_B]: "complete" })), undefined);
	// Without the hook (an older index.ts) nothing changes.
	assert.equal(bash(`${app}npm run verify`), undefined);
});

// --- the pictures Michael sent, for the screen comparison ---

test("userPictures: the last two images from user messages on the branch, each with the words it came with", () => {
	const img = (data: string) => ({ type: "image", data, mimeType: "image/png" });
	const user = (content: unknown[]) => ({ type: "message", message: { role: "user", content } });
	const branch = [
		user([{ type: "text", text: "lets build a guitar app" }]),
		user([{ type: "text", text: "Make it look more like\n this style" }, img("a")]),
		{ type: "message", message: { role: "assistant", content: [img("x")] } },
		{ type: "message", message: { role: "toolResult", content: [img("y")] } },
		user([img("b"), { type: "text", text: "This is what I'm seeing." }]),
		user([{ type: "text", text: "two at once" }, img("c"), img("d")]),
	];
	assert.deepEqual(userPictures(branch), [
		{ text: "two at once", data: "c", mimeType: "image/png" },
		{ text: "two at once", data: "d", mimeType: "image/png" },
	]);
	assert.deepEqual(userPictures(branch, 3)[0], { text: "This is what I'm seeing.", data: "b", mimeType: "image/png" });
	assert.deepEqual(userPictures(branch, 4)[0], { text: "Make it look more like this style", data: "a", mimeType: "image/png" });
	assert.deepEqual(userPictures([user([{ type: "text", text: "no picture" }])]), []);
	assert.deepEqual(userPictures([user("a plain string" as unknown as unknown[])]), []);
});

test("screenCompareContent: spec and pictures when there are any, and always the comparison owed", () => {
	const none = screenCompareContent(undefined, []);
	assert.equal(none.length, 1);
	assert.match((none[0] as { text: string }).text, /^Compare the screen with Michael's request and write down what differs/);
	const both = screenCompareContent("# Spec\n- rule", [{ text: "like this", data: "a", mimeType: "image/png" }]);
	assert.deepEqual(
		both.map((b) => b.type),
		["text", "text", "image", "text"],
	);
	assert.equal((both[0] as { text: string }).text, "docs/spec.md, what the screen must match:\n\n# Spec\n- rule");
	assert.equal((both[1] as { text: string }).text, 'Michael sent this picture with: "like this"');
	assert.match((both[3] as { text: string }).text, /docs\/spec\.md, Michael's pictures above \(what he asked for, or what he saw broken\), Michael's request/);
});

// --- a review without a verdict never counts (keeb run 2026-11-12 22:45: the reviewer's report stayed in its reasoning) ---

test("reviewVerdict: the reviewer.md report shapes count, a mid-review line or nothing does not", () => {
	assert.equal(reviewVerdict("## Review\n- Finding: P2, off by one, src/a.ts:3, evidence, fix\n- Checked: a.ts\n- Merge verdict: OK with notes"), true);
	assert.equal(reviewVerdict("## Review\n- Checked: every hunk\n- Merge verdict: OK"), true);
	assert.equal(reviewVerdict("No issues found."), true);
	assert.equal(reviewVerdict("Run fan-out: 1/64 used\n\nNo issues found.\nMission: cf39d943 (completed)"), true);
	// fret run 2026-11-13 22:10: a complete review with emphasised labels was sent back and reviewed twice.
	assert.equal(reviewVerdict("## Review\n\n- **P2: Empty CSS rule** — `src/ui/scale-view.ts:36`. Dead CSS.\n- **Checked**: grid alignment ✓\n- **Merge verdict**: OK with notes (P2 items are non-blocking cleanup)."), true);
	assert.equal(reviewVerdict("## Review\n- __Finding__: P1, off by one, src/a.ts:3\n- __Merge verdict__: BLOCK"), true);
	assert.equal(reviewVerdict("Now let me check one more thing — how `tk-stat` renders its `.value`:\nMission: cf39d943 (completed)"), false);
	assert.equal(reviewVerdict(""), false);
	assert.equal(reviewVerdict("## Review"), false, "a heading alone is not a verdict");
	// keeb 2026-11-16: the 35B's heading shapes, five scoped reviews discarded and the PR never opened.
	assert.equal(reviewVerdict("## Review\n- P2 ...\n\n## Checked\n- a.ts\n\n## Merge verdict: OK\nNo code defects in the diff."), true, "verdict as a heading");
	assert.equal(reviewVerdict("## Review\n\n### New Issues\n\n#### P1 — `labelToBrowserKey` won't match layer keys\nbody\n\n### Assessment"), true, "finding level as a heading with an em-dash");
	assert.equal(reviewVerdict("## Review\n## Checked\n## Merge verdict: OK with notes\nplease confirm"), true);
	assert.equal(reviewVerdict("## Review\nNo defects found."), true);
	assert.equal(reviewVerdict("## Review\n### Issues\n#### Critical (Must Fix)\n- thing"), false, "severity words without a level or verdict are not the contract");
	assert.equal(reviewVerdict('{"reviewFindings": ["No blockers."]}'), false, "the JSON report is not the contract");
	// keeb 2026-11-22: Flash-Next's revived reviews, every one a verdict to the reader and none to the gate.
	assert.equal(reviewVerdict("## Review\n**Both P1s are closed. Verdict: OK with notes** — nothing the diff breaks; three one-liners left, all optional.\n### Closed\n- **P1 hint line** → fixed"), true, "a verdict without Merge, after a lead-in sentence");
	assert.equal(reviewVerdict("## Review\n**Clean. Merge verdict: OK** — the two lines are exactly what the notes asked for."), true, "a lead-in word before the verdict");
	assert.equal(reviewVerdict("## Review\n**Verdict first: BLOCK** — two behaviors the spec names have no test."), true);
	assert.equal(reviewVerdict("## Review\nThe verdict depends on the caller: see below."), false, "prose about a verdict is not one");
});

test("pending reviews count only when the finished run's reply holds a verdict", () => {
	const dir = "/home/m/workspace/apps/keeb";
	const res = (text: string) => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } });
	const branch = [{ type: "message", message: { role: "user", content: "go" } }, res(reviewPendingMark(dir, "aaaaaaa", "run-a"))];
	const complete: RunState = () => "complete";
	assert.equal(reviewedSinceUser(branch, complete, () => "## Review\n- Merge verdict: OK"), true);
	assert.equal(lastReview(branch, dir, complete, () => "No issues found."), "aaaaaaa");
	assert.equal(reviewedSinceUser(branch, complete, () => "Now let me check one more thing:"), false, "no verdict");
	assert.equal(lastReview(branch, dir, complete, () => "Now let me check one more thing:"), undefined);
	assert.equal(reviewedSinceUser(branch, complete, () => undefined), false, "transcript gone: fail closed");
	// A finished (sync) mark was only written after the guard saw a verdict, so it needs no transcript.
	assert.equal(reviewedSinceUser([...branch, res(reviewMark(dir, "bbbbbbb"))], () => "missing", () => undefined), true);
});

test("defaultRunText: the assistant's replies from the run's session file named in status.json", () => {
	const root = mkdtempSync(join(tmpdir(), "guard-runtext-"));
	const session = join(root, "session.jsonl");
	const entry = (role: string, content: unknown) => JSON.stringify({ type: "message", message: { role, content } });
	writeFileSync(session, [entry("user", "Task: review"), entry("assistant", [{ type: "thinking", thinking: "## Review\n- Merge verdict: OK" }, { type: "text", text: "Let me check" }, { type: "toolCall", id: "t", name: "read", arguments: {} }]), entry("toolResult", [{ type: "text", text: "- Merge verdict: OK (in a file the reviewer read)" }]), entry("assistant", [{ type: "text", text: "No issues found." }])].join("\n") + "\n");
	mkdirSync(join(root, "run-x"));
	writeFileSync(join(root, "run-x", "status.json"), JSON.stringify({ state: "complete", sessionFile: session }));
	assert.equal(defaultRunText("run-x", root), "Let me check\nNo issues found.", "text parts only: never thinking, never tool results");
	assert.equal(defaultRunText("run-missing", root), undefined);
	writeFileSync(join(root, "run-x", "status.json"), JSON.stringify({ state: "complete", sessionFile: join(root, "gone.jsonl") }));
	assert.equal(defaultRunText("run-x", root), undefined);
});

// --- async subagent runs hold the nudges like bg_bash jobs (keeb runs 2026-11-12 20:16 and 23:42: nudged while the worker ran) ---

const RUN_W = "05b6b587-d63e-4ca2-840a-3e642a55876e";
const RUN_V = "79294cfd-e523-4cfe-a8fd-346fee8607b9";
const subLaunch = (agent: string) => ({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `c-${agent}`, name: "subagent", arguments: { agent, task: "do it" } }] });
const asyncStarted = (agent: string, run: string) => ({ role: "toolResult", toolName: "subagent", content: [{ type: "text", text: `Run fan-out: 1/64 used\nAsync: ${agent} [${run}]\n\nThe async run is detached and running in the background.` }], details: { asyncId: run } });
const revived = (from: string, run: string) => ({ role: "toolResult", toolName: "subagent", content: [{ type: "text", text: `Revived async subagent from ${from}. Revived run: ${run}\nAgent: worker` }] });
const notify = (outcome: "completed" | "failed", run: string) => ({ role: "custom", customType: "subagent-notify", content: `Background task ${outcome}: **worker**\n\nworker:\n\nImplemented.\n\nRetention-managed async directory: /tmp/pi-subagents-uid-1000/async-subagent-runs/${run}` });

test("no end-of-turn nudge while an async subagent run of the turn has not reported back", () => {
	const keeb = editApp("/home/m/workspace/apps/keeb/src/x.ts");
	const waiting = [user, keeb, result, subLaunch("worker"), asyncStarted("worker", RUN_W), say("Worker is on it; you'll get a notice when it's done.")];
	assert.equal(shouldNudge(waiting), false);
	assert.equal(shouldNudgeTodos(waiting, [{ id: 1, subject: "plural helper", status: "in_progress" }]), false);
	assert.equal(shouldNudgePr(waiting, ["/home/m/workspace/apps/keeb"]), false);
	// The run id from details when the text has none.
	const bare = { ...asyncStarted("worker", RUN_W), content: [{ type: "text", text: "launched" }] };
	assert.equal(shouldNudge([user, keeb, result, subLaunch("worker"), bare, say("Running.")]), false);
	// A reviewer run holds too: its result decides the next step.
	assert.equal(shouldNudgePr([user, keeb, result, subLaunch("reviewer"), asyncStarted("reviewer", RUN_V), say("Reviewer running.")], ["/home/m/workspace/apps/keeb"]), false);
});

test("nudges come back once the run's subagent-notify message arrived, and a revived run holds until its own", () => {
	const keeb = editApp("/home/m/workspace/apps/keeb/src/x.ts");
	const done = [user, keeb, result, subLaunch("worker"), asyncStarted("worker", RUN_W), say("Running."), notify("completed", RUN_W), keeb, result, say("")];
	assert.equal(shouldNudge(done), true);
	assert.equal(shouldNudgeTodos(done, [{ id: 1, subject: "plural helper", status: "in_progress" }]), true);
	assert.equal(shouldNudgePr(done, ["/home/m/workspace/apps/keeb"]), true);
	// Another run's notice does not count.
	assert.equal(shouldNudge([user, keeb, result, subLaunch("worker"), asyncStarted("worker", RUN_W), notify("completed", RUN_V), say("")]), false);
	// A failed run reports back too; resuming it opens a new run that holds until its own notice.
	const failedThenRevived = [user, keeb, result, subLaunch("worker"), asyncStarted("worker", RUN_W), say("Running."), notify("failed", RUN_W), subLaunch("worker"), revived(RUN_W, RUN_V), say("Resumed.")];
	assert.equal(shouldNudge(failedThenRevived), false);
	assert.equal(shouldNudge([...failedThenRevived, notify("completed", RUN_V), keeb, result, say("")]), true);
	// A sync launch result is the run itself: nothing to wait for.
	const sync = { role: "toolResult", toolName: "subagent", content: [{ type: "text", text: "Run fan-out: 1/64 used\n\nImplemented.\nMission: abc (completed)" }], details: { mode: "single", results: [] } };
	assert.equal(shouldNudge([user, keeb, result, subLaunch("worker"), sync, say("")]), true);
});

// --- look at the screen before the review, the PR and the first ship ---

import { lastScreen, screenMark, screenResult, screenshotDir, uiFile } from "../rules.ts";

test("uiFile: what the app draws from; docs, tests, config and briefs are not", () => {
	for (const f of ["index.html", "src/app-main.ts", "src/ui/scale-view.ts", "src/styles.css", "public/extra.css"]) assert.equal(uiFile(f), true, f);
	for (const f of ["docs/spec.md", "test/a.test.ts", "e2e/a.spec.ts", ".superpowers/sdd/spec/task-1-brief.md", "package.json", "vite.config.ts", "public/icons/icon.svg", "README.md"]) assert.equal(uiFile(f), false, f);
});

test("screenshotDir names the app a screenshot command pictures", () => {
	assert.equal(screenshotDir("node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts screenshot ~/workspace/apps/keeb --path /stats", home, home), "/home/m/workspace/apps/keeb");
	assert.equal(screenshotDir("node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/keeb --title t --body b", home, home), undefined);
	assert.equal(screenshotDir("npm run screenshot", home, home), undefined);
});

test("lastScreen reads the latest mark for the app off tool results, never an error result", () => {
	const dir = "/home/m/workspace/apps/keeb";
	const res = (text: string, isError = false) => ({ type: "message", message: { role: "toolResult", isError, content: [{ type: "text", text }] } });
	assert.equal(lastScreen([], dir), undefined);
	assert.equal(lastScreen([res(screenMark(dir, "a".repeat(40))), res(screenMark(dir, "b".repeat(40)))], dir), "b".repeat(40));
	assert.equal(lastScreen([res(screenMark(dir, "a".repeat(40))), res(screenMark(dir, "b".repeat(40)), true)], dir), "a".repeat(40));
	assert.equal(lastScreen([res(screenMark("/home/m/workspace/apps/tips", "a".repeat(40)))], dir), undefined);
});

test("screenResult reads the picture's path off the command's RESULT line", () => {
	assert.equal(screenResult('some stderr\nRESULT {"ok":true,"file":"/x/test-results/screens/phone-dark.png","width":780,"height":2058,"issues":[]}\n'), "/x/test-results/screens/phone-dark.png");
	assert.equal(screenResult('RESULT {"ok":false,"reason":"no vite"}'), undefined);
	assert.equal(screenResult("Error: ENOENT"), undefined);
	assert.equal(screenResult("RESULT {not json}"), undefined);
});

test("pr needs a look when UI files changed, ship always; the review gate comes after the look", () => {
	const pr = "cd ~/workspace/apps/keeb && node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/keeb --title t --body b";
	const ship = pr.replace(" pr ", " ship ");
	const base = { cwd: "/home/m", home: "/home/m", hasScript: () => false, dirty: () => false, reviewed: () => false, codeChanged: () => true };
	assert.deepEqual(checkShell(pr, { ...base, screenSeen: () => false, uiChanged: () => true }), { block: true, reason: REASONS.screen });
	assert.deepEqual(checkShell(pr, { ...base, screenSeen: () => true, uiChanged: () => true }), { block: true, reason: REASONS.review }, "looked, not yet reviewed");
	assert.deepEqual(checkShell(pr, { ...base, screenSeen: () => false, uiChanged: () => false }), { block: true, reason: REASONS.review }, "logic-only change needs no look");
	assert.deepEqual(checkShell(ship, { ...base, screenSeen: () => false, uiChanged: () => false }), { block: true, reason: REASONS.screen }, "a first version always has a screen");
	assert.equal(checkShell(ship, { ...base, screenSeen: () => true, uiChanged: () => false }), undefined);
	assert.equal(checkShell(pr, { ...base, reviewed: () => true, screenSeen: () => true, uiChanged: () => true }), undefined);
	assert.deepEqual(checkShell(pr, { ...base }), { block: true, reason: REASONS.review }, "without the check the old gate alone applies");
	assert.match(REASONS.screen, /thatsit-app\.ts screenshot <dir>/);
});

test("reviewVerdict: a verdict line without a list dash counts too (fret 2026-11-14 21:33)", () => {
	assert.equal(reviewVerdict("## Review\n\n**Finding:** None.\n\n**Merge verdict: OK**"), true);
	assert.equal(reviewVerdict("## Review\nChecked everything.\nMerge verdict: OK"), true);
	assert.equal(reviewVerdict("## Review\nI am still reading the diff."), false);
});

// --- a follow-up a stop withdrew is named on the next resume of that worker (fret 2026-11-14 19:33 → 20:02) ---

const call = (id: string, args: Record<string, unknown>) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: args }] } });
const res = (id: string, text: string) => ({ type: "message", message: { role: "toolResult", toolCallId: id, isError: false, content: [{ type: "text", text }] } });
const notified = (text: string) => ({ type: "custom_message", customType: "subagent-notify", content: text });
const L = "4b06b6d8-bc17-4715-ac06-eae2787245ca";
const X = "96ab932e-2cba-4b01-ac45-7d286b918a4b";
const Y = "faff5de0-b639-498c-9c60-14897d9ffcf7";
const launched = [call("c1", { agent: "worker", task: "Build it" }), res("c1", `Run fan-out: 1/64 used\nAsync: worker [${L}]\n`), notified(`Background task completed: **worker** ... ${L}`)];
const revive = (c: string, from: string, msg: string, to: string) => [call(c, { action: "resume", id: from, message: msg }), res(c, `Revived async subagent from ${from}.\nRevived run: ${to}\nAgent: worker`)];

test("withdrawnFollowUps: the message of a revived run that was stopped is withdrawn for the whole chain, once", () => {
	const branch = [...launched, ...revive("c2", L, "Remove the dialog border and radius.", X), call("c3", { action: "stop", id: X }), res("c3", `Stop requested for async run ${X}.`), notified(`Background task stopped: **worker**  Subagent stopped by user. .../${X}`)];
	assert.deepEqual(withdrawnFollowUps(branch, L), ["Remove the dialog border and radius."]);
	assert.deepEqual(withdrawnFollowUps(branch, X), ["Remove the dialog border and radius."], "any id in the chain");
	assert.deepEqual(withdrawnFollowUps(branch, "96ab932e"), ["Remove the dialog border and radius."], "a prefix too");
	assert.deepEqual(withdrawnFollowUps(branch, "other-run"), []);
	// The next resume on the chain carried the note: nothing is owed after it.
	const noted = [...branch, ...revive("c4", L, "Fix the reviewer's findings.", Y)];
	assert.deepEqual(withdrawnFollowUps(noted, Y), []);
	assert.deepEqual(withdrawnFollowUps(noted, L), []);
});

test("withdrawnFollowUps: a stop after the run already finished withdraws nothing; a stop by prefix counts", () => {
	const done = [...launched, ...revive("c2", L, "Add the icon.", X), notified(`Background task completed: **worker** ... ${X}`), call("c3", { action: "stop", id: X }), res("c3", "Stop requested.")];
	assert.deepEqual(withdrawnFollowUps(done, L), []);
	const prefix = [...launched, ...revive("c2", L, "Add the icon.", X), call("c3", { action: "stop", id: "96ab932e" }), res("c3", "Stop requested.")];
	assert.deepEqual(withdrawnFollowUps(prefix, L), ["Add the icon."]);
});

test("noteWithdrawn prepends the note to a resume on a chain with a stopped follow-up and leaves other calls alone", () => {
	const branch = [...launched, ...revive("c2", L, "Remove the dialog border.\nKeep the shadow.", X), call("c3", { action: "stop", id: X }), res("c3", "Stop requested.")];
	const input: Record<string, unknown> = { action: "resume", id: L, message: "Replace the icon." };
	assert.equal(noteWithdrawn(input, branch), true);
	assert.equal(input.message, `${withdrawnNote(["Remove the dialog border.\nKeep the shadow."])}\n\nReplace the icon.`);
	assert.match(String(input.message), /^\[pi-guard\] Michael stopped your previous run before it finished, which withdraws the follow-up it carried: "Remove the dialog border\. Keep the shadow\."\. Do not act on it/);
	const fresh: Record<string, unknown> = { agent: "worker", task: "x" };
	assert.equal(noteWithdrawn(fresh, branch), false);
	assert.deepEqual(fresh, { agent: "worker", task: "x" });
	const clean: Record<string, unknown> = { action: "resume", id: L, message: "m" };
	assert.equal(noteWithdrawn(clean, launched), false);
	assert.equal(clean.message, "m");
});

test("promptDigest hashes the system text and each message; the hashes move only where the request changed", () => {
	const a = promptDigest({ model: "m", messages: [{ role: "system", content: "rules" }, { role: "user", content: "hi" }, { role: "assistant", content: "yo" }] })!;
	assert.equal(a.model, "m");
	assert.equal(a.msgs.length, 2);
	assert.ok(a.chars > 50);
	const b = promptDigest({ model: "m", messages: [{ role: "system", content: "rules" }, { role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "next" }] })!;
	assert.equal(b.sys, a.sys);
	assert.deepEqual(b.msgs.slice(0, 2), a.msgs);
	const c = promptDigest({ model: "m", messages: [{ role: "system", content: "rules v2" }, { role: "user", content: "hi" }] })!;
	assert.notEqual(c.sys, a.sys);
	assert.equal(c.msgs[0], a.msgs[0]);
	// Anthropic-style payloads carry the system text beside the messages.
	const d = promptDigest({ system: "rules", messages: [{ role: "user", content: "hi" }] })!;
	assert.equal(d.msgs.length, 1);
	assert.equal(promptDigest({ model: "m" }), undefined);
	assert.equal(promptDigest("x"), undefined);
});

test("merging or closing a PR is blocked with or without an app path; reading PRs and local merges are not", () => {
	assert.equal(bash(`${app}gh pr merge 28 --repo thats-it-dev/keeb --squash --delete-branch 2>&1 | head -5`), REASONS.merge);
	assert.equal(bash("gh pr merge 28 --repo thats-it-dev/keeb"), REASONS.merge, "no app path in the command");
	assert.equal(bash("gh pr close 28 --repo thats-it-dev/keeb"), REASONS.merge);
	assert.equal(bash("gh api -X PUT repos/thats-it-dev/keeb/pulls/28/merge"), REASONS.merge);
	assert.equal(bash("gh api --method PUT /repos/thats-it-dev/keeb/pulls/28/merge -f merge_method=squash"), REASONS.merge);
	assert.equal(bash("gh api repos/thats-it-dev/keeb/pulls/28/merge"), REASONS.merge, "GET on the merge endpoint is still the merge endpoint");
	assert.equal(checkToolCall("bg_bash", { command: "gh pr merge 28" }, env())?.reason, REASONS.merge);
	assert.equal(bash(`${app}gh pr view 28 --json state,mergedAt`), undefined);
	assert.equal(bash(`${app}gh pr list --state merged --head feat/x --json number`), undefined);
	assert.equal(bash(`${app}git fetch origin main && git merge --ff-only origin/main`), undefined);
	assert.equal(bash(`${app}git commit -m "docs: say gh pr merge is Michael's"`), undefined, "quoted text is not a command");
	assert.match(REASONS.merge, /Michael merges/);
	assert.match(REASONS.merge, /end your turn/);
});

test("the orchestrator reason no longer calls merges the orchestrator's, and the PR nudge says Michael merges", () => {
	assert.doesNotMatch(REASONS.orchestrator, /Merges/);
	assert.match(REASONS.orchestrator, /Michael's to merge/);
	assert.match(prNudge(["/home/m/workspace/apps/keeb"]), /Michael merges the PR; never merge or close it yourself/);
});

test("reviewGap says why the review gate is shut, and orders a stop after three blocks with no new review", () => {
	const dir = "/home/m/workspace/apps/keeb";
	const user = { type: "message", message: { role: "user", content: "go" } };
	const res = (text: string, isError = false) => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }], isError } });
	const blocked = res("Blocked: run the reviewer before opening the PR. Run `npm run verify`...", true);
	assert.match(reviewGap([user], dir) ?? "", /^No reviewer call since Michael's last message was scoped to this repo/);
	assert.equal(reviewGap([user, res(reviewPendingMark(dir, "aaaaaaa", "run-a"))], dir, () => "running"), "The last scoped review (run run-a) is still running: wait for its subagent-notify message, then run this command again.");
	assert.match(reviewGap([user, res(reviewPendingMark(dir, "aaaaaaa", "run-a"))], dir, () => "complete", () => "Let me look at one more file") ?? "", /ended without a verdict the guard accepts/);
	assert.equal(reviewGap([user, res(reviewPendingMark(dir, "aaaaaaa", "run-a"))], dir, () => "complete", () => "## Review\n- Merge verdict: OK"), undefined, "a counted review has no gap");
	assert.match(reviewGap([user, res(reviewPendingMark(dir, "aaaaaaa", "run-a"))], dir, () => "failed") ?? "", /failed: call the reviewer again/);
	assert.match(reviewGap([user, res(reviewPendingMark(dir, "aaaaaaa", "run-a"))], dir, () => "missing") ?? "", /has no run directory any more/);
	// Three blocks with no new review in between: the fourth reason opens with the stop order.
	const two = reviewGap([user, blocked, blocked], dir) ?? "";
	assert.doesNotMatch(two, /stop retrying/);
	const four = reviewGap([user, blocked, blocked, blocked], dir) ?? "";
	assert.match(four, /^This is the 4th time this command is blocked with no new review in between: stop retrying\. Tell Michael/);
	// A new scoped review resets the count, and Michael's next message resets everything.
	assert.doesNotMatch(reviewGap([user, blocked, blocked, blocked, res(reviewPendingMark(dir, "bbbbbbb", "run-b"))], dir, () => "running") ?? "", /stop retrying/);
	assert.doesNotMatch(reviewGap([user, blocked, blocked, blocked, user], dir) ?? "", /stop retrying/);
	assert.equal(REVIEW_PENDING_MARK, "[pi-guard] review pending ");
});

test("the pr block carries the gap text when the env has one", () => {
	const pr = "cd ~/workspace/apps/keeb && node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/keeb --title t --body b";
	const base = { cwd: "/home/m", home: "/home/m", hasScript: () => false, dirty: () => false, reviewed: () => false, codeChanged: () => true };
	assert.equal(checkShell(pr, { ...base, reviewGap: () => "why" })?.reason, `${REASONS.review}\nwhy`);
	assert.equal(checkShell(pr, { ...base, reviewGap: () => undefined })?.reason, REASONS.review);
});

test("reviewBlocked: a BLOCK merge verdict, or a P0/P1 finding without a verdict line, shuts the gate", () => {
	assert.equal(reviewBlocked("## Review\n- Finding: P0 - space switches layers\n\n**Merge verdict: BLOCK**\n\nThe diff..."), true, "keeb 2026-11-17 shape");
	assert.equal(reviewBlocked("## Review\n### Merge verdict: BLOCK"), true);
	assert.equal(reviewBlocked("## Review\n- **Merge verdict:** **Block**"), true);
	assert.equal(reviewBlocked("## Review\n- Finding: P2 - nit\n- Merge verdict: OK with notes"), false);
	assert.equal(reviewBlocked("## Review\n- Finding: P1 - no test drives the space key\n- Merge verdict: OK"), false, "the verdict line wins");
	assert.equal(reviewBlocked("## Review\n- Finding: P1 - no test drives the space key"), true, "no verdict line: P1 blocks");
	assert.equal(reviewBlocked("## Review\n#### P0 — wrong key"), true);
	assert.equal(reviewBlocked("## Review\n- **P2:** a note"), false);
	assert.equal(reviewBlocked("No issues found."), false);
	assert.equal(reviewBlocked("Let me look at one more file"), false, "no verdict at all");
	// keeb 2026-11-22 shapes: the lead-in and the missing "Merge" change nothing about what the verdict says.
	assert.equal(reviewBlocked("## Review\n**Verdict first: BLOCK** — two P1 test gaps.\n- **P1 — hint line** never asserted"), true);
	assert.equal(reviewBlocked("## Review\n**Both P1s are closed. Verdict: OK with notes** — three one-liners left.\n- **P1 hint line** → `e2e/x.spec.ts:57`"), false, "OK with notes, even with P1 labels in the closed list");
	assert.equal(reviewBlocked("## Review\n**Clean. Merge verdict: OK** — only assertions added."), false);
});

test("a review that ended BLOCK never counts for the gate or as the next base, and lastBlockedReview names its tree", () => {
	const dir = "/home/m/workspace/apps/keeb";
	const res = (text: string) => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } });
	const user = { type: "message", message: { role: "user", content: "go" } };
	const complete: RunState = () => "complete";
	const block = () => "## Review\n- Finding: P0 - space switches layers\n\n**Merge verdict: BLOCK**";
	const async = [user, res(reviewPendingMark(dir, "aaaaaaa", "run-a"))];
	assert.equal(reviewedSinceUser(async, complete, block), false, "async BLOCK");
	assert.equal(lastReview(async, dir, complete, block), undefined);
	assert.equal(lastBlockedReview(async, dir, complete, block), "aaaaaaa");
	const sync = [user, res(reviewBlockedMark(dir, "bbbbbbb"))];
	assert.equal(reviewedSinceUser(sync, () => "missing", () => undefined), false, "sync BLOCK");
	assert.equal(lastReview(sync, dir, () => "missing", () => undefined), undefined);
	assert.equal(lastBlockedReview(sync, dir, () => "missing", () => undefined), "bbbbbbb");
	const fixed = [...sync, res(reviewMark(dir, "ccccccc"))];
	assert.equal(lastBlockedReview(fixed, dir), undefined, "a later counted review clears it");
	assert.equal(lastReview(fixed, dir), "ccccccc");
	assert.equal(lastBlockedReview(sync, "/home/m/workspace/apps/fret"), undefined, "another app");
});

test("reviewGap after a BLOCK sends the findings to the worker or to Michael, never back to the reviewer", () => {
	const dir = "/home/m/workspace/apps/keeb";
	const res = (text: string) => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } });
	const user = { type: "message", message: { role: "user", content: "go" } };
	const block = () => "## Review\n**Merge verdict: BLOCK**";
	const gap = reviewGap([user, res(reviewPendingMark(dir, "aaaaaaa", "run-a"))], dir, () => "complete", block) ?? "";
	assert.match(gap, /^The last scoped review \(run run-a\) ended with the merge verdict BLOCK/);
	assert.match(gap, /tell Michael which finding and why, and end your turn/);
	assert.match(reviewGap([user, res(reviewBlockedMark(dir, "bbbbbbb"))], dir) ?? "", /^The last scoped review ended with the merge verdict BLOCK/);
	assert.equal(reviewGap([user, res(reviewBlockedMark(dir, "bbbbbbb")), res(reviewMark(dir, "ccccccc"))], dir), undefined, "the fix was reviewed");
});

test("designDoc: specs and plans under docs/superpowers, nothing else", () => {
	assert.equal(designDoc("docs/superpowers/specs/2026-11-17-layered-keymap-design.md"), true);
	assert.equal(designDoc("docs/superpowers/plans/2026-11-17-layered-keymaps.md"), true);
	assert.equal(designDoc("docs/spec.md"), false);
	assert.equal(designDoc("README.md"), false);
	assert.equal(designDoc(".superpowers/sdd/x/task-1-brief.md"), false);
});

test("a spec or plan PR needs a review even with no code change", () => {
	const pr = "cd ~/workspace/apps/keeb && node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/keeb --title t --body b";
	const base = { cwd: "/home/m", home: "/home/m", hasScript: () => false, dirty: () => false, reviewed: () => false, codeChanged: () => false };
	assert.equal(checkShell(pr, { ...base, docsChanged: () => true })?.block, true, "a plan on the branch");
	assert.equal(checkShell(pr, { ...base, docsChanged: () => false }), undefined, "README only");
	assert.match(checkShell(pr, { ...base, docsChanged: () => true })?.reason ?? "", /design doc or plan/);
});

test("reviewHeader: a docs-only diff gets the doc brief, not the code one", () => {
	const scope = { dir: "/home/m/workspace/apps/keeb", base: "abcdef0123", baseFrom: "main" as const, diffPath: "/tmp/keeb-review.diff", files: [{ path: "docs/superpowers/specs/2026-11-17-x-design.md", added: "80", removed: "0" }, { path: "docs/superpowers/plans/2026-11-17-x.md", added: "200", removed: "0" }], request: "review the plan" };
	const docs = reviewHeader({ ...scope, kind: "docs" });
	assert.match(docs, /review of a design doc and its implementation plan, not of code/);
	assert.match(docs, /hole between plan and spec/);
	assert.match(docs, /a worker cannot follow/);
	assert.match(docs, /renumbers or contradicts/);
	assert.match(docs, /\[Michael's request, verbatim/);
	assert.match(docs, /point it drops or contradicts is a P1/);
	assert.doesNotMatch(docs, /verify/);
	assert.doesNotMatch(docs, /cite the test in the diff/);
	const plan = reviewHeader({ ...scope, kind: "docs", files: [scope.files[1]] });
	assert.match(plan, /review of an implementation plan/);
	assert.doesNotMatch(plan, /decision the doc leaves open/);
	const spec = reviewHeader({ ...scope, kind: "docs", files: [scope.files[0]] });
	assert.match(spec, /review of a design doc,/);
	assert.match(spec, /decision the doc leaves open/);
	assert.doesNotMatch(spec, /hole between plan and spec/);
	const code = reviewHeader({ ...scope, kind: "code" });
	assert.match(code, /npm run verify/);
	assert.doesNotMatch(reviewHeader(scope), /not of code/, "kind defaults to code");
});

// --- Michael's file is the oracle (keeb PR #31, 2026-11-17: tests asserted the code's own output, the spec the same wrong rule) ---

import { requestFiles, screenshotUpload } from "../rules.ts";

test("requestFiles: the existing files Michael's request names by path, ~ expanded, punctuation stripped, four at most", () => {
	const isFile = (p: string) => p.endsWith(".json") || p.endsWith(".md");
	assert.deepEqual(requestFiles(undefined, home, isFile), []);
	assert.deepEqual(requestFiles("upload the keyboard JSON like the one at ~/workspace/keymaps/go60-36.json, and hint the layer.", home, isFile), ["/home/m/workspace/keymaps/go60-36.json"]);
	assert.deepEqual(requestFiles("see /home/m/a.json and `~/b.md` (also ~/b.md) but not ~/missing.txt or /dev/null", home, isFile), ["/home/m/a.json", "/home/m/b.md"]);
	assert.deepEqual(requestFiles("~/1.json ~/2.json ~/3.json ~/4.json ~/5.json", home, isFile).length, 4);
	assert.deepEqual(requestFiles("a url https://x.y/z.json is not a path", home, isFile), []);
});

test("reviewHeader with inputs makes the file the oracle above spec and tests, in the code brief and the doc brief", () => {
	const scope = { dir: "/home/m/workspace/apps/keeb", base: "0123456789ab", baseFrom: "main" as const, diffPath: "/tmp/keeb-review.diff", request: "use ~/workspace/keymaps/go60-36.json", inputs: ["/home/m/workspace/keymaps/go60-36.json"] };
	const code = reviewHeader({ ...scope, files: [{ path: "src/a.ts", added: "3", removed: "1" }] });
	assert.match(code, /Michael's file: \/home\/m\/workspace\/keymaps\/go60-36\.json\. It is the oracle, above docs\/spec\.md and above the tests\./);
	assert.match(code, /pick ten entries/);
	assert.match(code, /An expected value that repeats the code's output[^.]*is a P1 finding and the merge verdict is BLOCK/);
	assert.match(code, /the file wins and the spec line is a P1/);
	assert.ok(code.indexOf("It is the oracle") < code.indexOf("[The parent's request]"));
	const docs = reviewHeader({ ...scope, kind: "docs", files: [{ path: "docs/superpowers/specs/2026-11-17-x.md", added: "3", removed: "1" }] });
	assert.match(docs, /Michael's file: \/home\/m\/workspace\/keymaps\/go60-36\.json\. Open it\. Every rule the document states about how such a file is read/);
	assert.match(docs, /a rule the file contradicts is a P1 and the merge verdict is BLOCK/);
	assert.doesNotMatch(docs, /It is the oracle/);
	const none = reviewHeader({ ...scope, inputs: [], files: [] });
	assert.doesNotMatch(none, /Michael's file/);
});

test("screenshotUpload reads the --upload file off the command, quoted or not, ~ expanded", () => {
	assert.equal(screenshotUpload("node x.ts screenshot ~/workspace/apps/keeb --upload ~/workspace/keymaps/go60-36.json", home), "/home/m/workspace/keymaps/go60-36.json");
	assert.equal(screenshotUpload(`node x.ts screenshot keeb --click 'button[aria-label="Settings"]' --upload "/tmp/my file.json" --scheme light`, home), "/tmp/my file.json");
	assert.equal(screenshotUpload("node x.ts screenshot keeb --path /stats", home), undefined);
});

test("screenCompareContent asks for the picture with Michael's file loaded until the command uploaded it; the mark says which", () => {
	const inputs = ["/home/m/workspace/keymaps/go60-36.json"];
	const without = screenCompareContent(undefined, [], inputs);
	assert.equal(without.length, 2);
	assert.match((without[0] as { text: string }).text, /^\[pi-guard\] Michael's request names \/home\/m\/workspace\/keymaps\/go60-36\.json, and this picture was taken without it\. .*--upload \/home\/m\/workspace\/keymaps\/go60-36\.json/);
	const other = screenCompareContent(undefined, [], inputs, "/tmp/else.json");
	assert.equal(other.length, 2);
	const withIt = screenCompareContent(undefined, [], inputs, inputs[0]);
	assert.equal(withIt.length, 1);
	assert.match((withIt[0] as { text: string }).text, /^Compare the screen with/);
	assert.equal(screenCompareContent(undefined, [], []).length, 1);
	assert.equal(screenMark("/home/m/workspace/apps/keeb", "a".repeat(40), inputs[0]), `[pi-guard] screen seen /home/m/workspace/apps/keeb at ${"a".repeat(40)} with ${inputs[0]}`);
	assert.equal(lastScreen([{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: screenMark("/home/m/workspace/apps/keeb", "a".repeat(40), inputs[0]) }] } }], "/home/m/workspace/apps/keeb"), "a".repeat(40));
});

// --- a reply that hands Michael a merge command ---

test("a reply that hands Michael a merge command is sent back once", () => {
	const handed = say("thatsit.dev is live. Task 7 of 7: cutover done, only your merge remains.\n\nRun this to ship the repo state:\n\n```\ngh pr merge 2 --merge\n```\n\nTL;DR [site cutover done]: PR #2 awaits your merge, CI green.");
	assert.equal(suggestsMerge("Run `gh pr merge 2 --merge` when you are happy."), true);
	assert.equal(suggestsMerge("Merge it now and I'll tag v1."), true);
	assert.equal(suggestsMerge("You can close it with gh pr close 4."), true);
	assert.equal(suggestsMerge("PR #2 is open and CI is green: https://github.com/m/site/pull/2 and the preview is live."), false);
	assert.equal(suggestsMerge("The merge-base is main; mergeAll sums the parts; the keymap merges two layers."), false);
	assert.equal(shouldNudgeMerge([user, handed]), true);
	assert.equal(shouldNudgeMerge([user, edit, result, handed]), true);
	assert.equal(shouldNudgeMerge([user, handed, { role: "custom", customType: MERGE_NUDGE_TYPE, content: "..." }, handed]), false);
	assert.equal(shouldNudgeMerge([user, long]), false);
	assert.equal(shouldNudgeMerge([user, edit]), false);
});

// --- the review gate on any repo under ~/workspace ---

test("workspacePath finds a non-app path under ~/workspace in a command, else takes the cwd", () => {
	assert.equal(workspacePath("cd ~/workspace/ref/worktrees/website-next && git push -u origin next", "/home/m", "/home/m"), "/home/m/workspace/ref/worktrees/website-next");
	assert.equal(workspacePath("git -C /home/m/workspace/pi-web push", "/home/m", "/home/m"), "/home/m/workspace/pi-web");
	assert.equal(workspacePath("cd ~/workspace/apps/keeb && git push", "/home/m", "/home/m"), undefined, "apps have their own rules");
	assert.equal(workspacePath("git push", "/home/m/workspace/ref/website", "/home/m"), "/home/m/workspace/ref/website");
	assert.equal(workspacePath("git push", "/home/m", "/home/m"), undefined);
	assert.equal(workspacePath("Review the branch in /home/m/workspace/ref/website.", "/home/m", "/home/m"), "/home/m/workspace/ref/website");
});

test("a push or gh pr create in a workspace repo outside apps needs a review, like an app's pr", () => {
	const repo = "/home/m/workspace/ref/worktrees/website-next";
	const base = { ...env(), repoRoot: (p: string) => (p.startsWith(repo) ? repo : undefined), reviewed: () => false, codeChanged: () => true };
	const push = `cd ${repo} && git push -u origin next`;
	assert.equal(checkShell(push, base)?.reason, REASONS.reviewRepo);
	assert.equal(checkShell(`cd ${repo} && gh pr create --base main --head next --title t --body b`, base)?.reason, REASONS.reviewRepo);
	assert.equal(checkShell(push, { ...base, reviewGap: () => "why" })?.reason, `${REASONS.reviewRepo}\nwhy`);
	assert.equal(checkShell(push, { ...base, reviewed: () => true }), undefined, "reviewed");
	assert.equal(checkShell(push, { ...base, codeChanged: () => false }), undefined, "docs only");
	assert.equal(checkShell(push, { ...base, codeChanged: () => false, docsChanged: () => true })?.reason, REASONS.reviewRepo, "a design doc gets its review");
	assert.equal(checkShell(`cd ${repo} && git commit -qm x && npm test`, base), undefined, "not a publish");
	assert.equal(checkShell("cd /home/m/elsewhere && git push", base), undefined, "outside workspace");
	assert.equal(checkShell(push, { ...base, repoRoot: () => undefined }), undefined, "not a git repo");
	assert.equal(checkShell(push, env()), undefined, "without the checks the command runs");
	assert.equal(checkShell("cd ~/workspace/apps/keeb && git push", base)?.reason, REASONS.push, "apps keep their own rule");
	assert.match(REASONS.reviewRepo, /^Blocked: run the reviewer before opening the PR/, "the stop-order counter in reviewGap reads this head");
});

test("verify in a repo outside apps counts by the command's cd target", () => {
	const repo = "/home/m/workspace/ref/website";
	const b = [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "e", name: "edit", arguments: { path: `${repo}/src/a.ts` } }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "v", name: "bash", arguments: { command: `cd ${repo} && npm run verify` } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "v", isError: false, content: [] } },
	];
	assert.equal(verifiedSinceEdit(b, repo, "/home/m", "/home/m"), true);
	assert.equal(verifiedSinceEdit(b.slice(0, 1), repo, "/home/m", "/home/m"), false);
});

test("reposNeedingPr: a workspace repo edited this run with no push or gh pr create after the edit, keyed by its git root", () => {
	const root = "/home/m/workspace/ref/worktrees/website-next";
	const repoRoot = (p: string) => (p.startsWith(root) ? root : undefined);
	const editRepo = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "write", arguments: { path: `${root}/src/render.ts` } }] };
	const push = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: { command: `cd ${root} && git push -q -u origin next && gh pr create --title t --body b` } }] };
	const bareCd = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: { command: "git push" } }] };
	const needs = (d: string) => d === root;
	assert.deepEqual(reposNeedingPr([user, editRepo, result, long], "/home/m", "/home/m", repoRoot, needs), [root]);
	assert.deepEqual(reposNeedingPr([user, editRepo, result, push, result, long], "/home/m", "/home/m", repoRoot, needs), [], "pushed after the edit");
	assert.deepEqual(reposNeedingPr([user, push, result, editRepo, result, long], "/home/m", "/home/m", repoRoot, needs), [root], "edited after the push");
	assert.deepEqual(reposNeedingPr([user, editRepo, result, bareCd, result, long], root, "/home/m", repoRoot, needs), [], "a bare push counts by the session cwd");
	assert.deepEqual(reposNeedingPr([user, editRepo, result, long], "/home/m", "/home/m", repoRoot, () => false), [], "nothing left to publish");
	assert.deepEqual(reposNeedingPr([user, editApp("~/workspace/apps/keeb/src/a.ts"), result, long], "/home/m", "/home/m", repoRoot, needs), [], "apps are the app nudge's");
	assert.match(repoPrNudge([root]), /website-next/);
	assert.match(repoPrNudge([root]), /gh pr create/);
	assert.match(repoPrNudge([root]), /never merge or close it yourself/);
});

test("in a workspace repo outside apps: CI is watched once through bg_bash, python rewrites and discards are blocked, e2e runs one spec", () => {
	const repo = "/home/m/workspace/ref/website";
	const base = { ...env(), repoRoot: (p: string) => (p.startsWith(repo) ? repo : undefined) };
	const at = (c: string) => `cd ${repo} && ${c}`;
	assert.equal(checkShell(at("sleep 75 && gh pr checks 2"), base)?.reason, REASONS.ciRepo, "the website session's poll");
	assert.equal(checkShell(at("gh run list --limit 3"), base)?.reason, REASONS.ciRepo);
	assert.equal(checkShell(at("gh run view 44447989416"), base)?.reason, REASONS.ciRepo);
	assert.equal(checkShell(at("gh run view 44447989416 --log-failed"), base), undefined, "reading the failing log is fine");
	assert.equal(checkShell(at("gh pr checks 2 --watch --fail-fast"), { ...base, tool: "bash" })?.reason, REASONS.ciRepo, "watching belongs to bg_bash");
	assert.equal(checkShell(at("gh pr checks 2 --watch --fail-fast"), { ...base, tool: "bg_bash" }), undefined);
	assert.equal(checkShell(at("gh run watch 1 --exit-status"), { ...base, tool: "bg_bash" }), undefined);
	assert.equal(checkShell(at("gh run watch 1 --exit-status"), { ...base, tool: "bash" })?.reason, REASONS.ciRepo);
	assert.equal(checkShell(at("python3 - <<'PY'\np='src/a.ts'\ns=open(p).read()\nopen(p,'w').write(s.replace('a','b'))\nPY"), base)?.reason, REASONS.rewrite);
	assert.equal(checkShell(at("git checkout -- src/a.ts"), base)?.reason, REASONS.discard);
	assert.equal(checkShell(at("git checkout -- src/a.ts"), { ...base, dirty: () => false }), undefined);
	assert.equal(checkShell(at("npm run e2e"), base)?.reason, REASONS.e2e);
	assert.equal(checkShell(at("npm run e2e"), { ...base, hasScript: () => false }), undefined, "no e2e:one script, no rule");
	assert.equal(checkShell(at("git push"), { ...base, reviewed: () => true }), undefined, "a reviewed push is not a CI wait");
	assert.equal(checkShell("cd /home/m/elsewhere && sleep 75 && gh pr checks 2", base), undefined, "outside workspace nothing applies");
});

test("the pair's code-path rule and the long-overwrite rule reach any path under ~/workspace", () => {
	assert.equal(appCodePath("/home/m/workspace/ref/website/src/render.ts", "/home/m", "/home/m"), true);
	assert.equal(appCodePath("/home/m/workspace/ref/website/docs/superpowers/plans/p.md", "/home/m", "/home/m"), false);
	assert.equal(appCodePath("/home/m/workspace/ref/website/.github/workflows/deploy.yml", "/home/m", "/home/m"), false);
	assert.equal(appCodePath("/home/m/workspace/ref/website/README.md", "/home/m", "/home/m"), false);
	assert.equal(appCodePath("/home/m/elsewhere/src/a.ts", "/home/m", "/home/m"), false);
	const lines = (p: string) => (p.endsWith("big.ts") ? 200 : undefined);
	assert.deepEqual(checkToolCall("write", { path: "/home/m/workspace/ref/website/src/big.ts", content: "x" }, env({ lines, rewrites: new Set() })), { block: true, reason: REASONS.overwrite });
	assert.equal(checkToolCall("write", { path: "/home/m/elsewhere/big.ts", content: "x" }, env({ lines, rewrites: new Set() })), undefined);
});

// --- the app's rules reach the session that works on it (keeb 2026-11-19: the skill's Style rules were never read) ---

import { appBrief, skillRead, styleRulesOf } from "../rules.ts";

const skillMd = "---\nname: thatsit-app\n---\n\n# thatsit.app apps\n\nintro\n\n## Style rules\n\n- Import Lit only from kit.\n- Use only kit components: `tk-sheet`.\n\n## When something fails\n\n- rerun\n";

test("styleRulesOf lifts the Style rules section out of the skill, heading included, and nothing without it", () => {
	assert.equal(styleRulesOf(skillMd), "## Style rules\n\n- Import Lit only from kit.\n- Use only kit components: `tk-sheet`.");
	assert.equal(styleRulesOf("# skill\n\n## Other\n\ntext\n"), undefined);
	assert.equal(styleRulesOf("## Style rules\n\n- last section\n"), "## Style rules\n\n- last section");
});

test("skillRead: a read of the thatsit-app SKILL.md on the branch, by any spelling of home; other reads are not one", () => {
	const read = (path: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "r", name: "read", arguments: { path } }] } });
	assert.equal(skillRead([], home), false);
	assert.equal(skillRead([read("/home/m/workspace/apps/keeb/AGENTS.md")], home), false);
	assert.equal(skillRead([read("/home/m/.pi/agent/skills/thatsit-app/README.md")], home), false);
	assert.equal(skillRead([read("~/.pi/agent/skills/thatsit-app/SKILL.md")], home), true);
	assert.equal(skillRead([read("/home/m/.pi/agent/skills/thatsit-app/SKILL.md")], home), true);
	// The skill's real location is a symlink into pi-web; a read through it counts too.
	assert.equal(skillRead([read("/home/m/workspace/pi-web/skills/thatsit-app/SKILL.md")], home), true);
});

test("appBrief carries AGENTS.md and the style rules, either alone, and nothing when there is nothing to carry", () => {
	const dir = "/home/m/workspace/apps/keeb";
	const both = appBrief(dir, "# keeb\n\n- rule", "## Style rules\n\n- kit");
	assert.ok(both);
	assert.match(both, /^\[pi-guard\] The rules of \/home\/m\/workspace\/apps\/keeb, which this session's cwd did not load: follow them in every change there\.\n\n<project_instructions path="\/home\/m\/workspace\/apps\/keeb\/AGENTS\.md">\n# keeb\n\n- rule\n<\/project_instructions>/);
	assert.match(both, /\n\nFrom the thatsit-app skill \(~\/\.pi\/agent\/skills\/thatsit-app\/SKILL\.md\), the rules every UI change in an app follows; the design system page it names has each pattern with its code:\n\n## Style rules\n\n- kit$/);
	const rulesOnly = appBrief(dir, undefined, "## Style rules\n\n- kit");
	assert.ok(rulesOnly);
	assert.doesNotMatch(rulesOnly, /project_instructions/);
	assert.match(rulesOnly, /^\[pi-guard\] From the thatsit-app skill/);
	const agentsOnly = appBrief(dir, "# keeb", undefined);
	assert.ok(agentsOnly);
	assert.doesNotMatch(agentsOnly, /thatsit-app skill/);
	assert.equal(appBrief(dir, undefined, undefined), undefined);
});

test("reviewHeader briefs the kit rules when the diff touches a UI file, and only then", () => {
	const scope = { dir: "/home/m/workspace/apps/keeb", base: "0123456789ab", baseFrom: "main" as const, diffPath: "/tmp/keeb-review.diff" };
	const kit = "## Style rules\n\n- Use only kit components: `tk-sheet`.";
	const ui = reviewHeader({ ...scope, files: [{ path: "src/ui/settings-dialog.ts", added: "3", removed: "1" }, { path: "test/a.test.ts", added: "1", removed: "0" }], kit });
	assert.match(ui, /\[Kit rules\. The diff touches UI files \(src\/ui\/settings-dialog\.ts\); check each changed UI file against these\.\]\n## Style rules\n\n- Use only kit components: `tk-sheet`\.\n/);
	assert.match(ui, /A changed UI file that hand-builds what the kit provides .* is a P1 finding and the merge verdict is BLOCK\./);
	assert.ok(ui.indexOf("[Kit rules.") < ui.indexOf("[The parent's request]"));
	const tests = reviewHeader({ ...scope, files: [{ path: "test/a.test.ts", added: "1", removed: "0" }], kit });
	assert.doesNotMatch(tests, /Kit rules/);
	const noKit = reviewHeader({ ...scope, files: [{ path: "src/ui/settings-dialog.ts", added: "3", removed: "1" }] });
	assert.doesNotMatch(noKit, /Kit rules/);
});

test("the screen comparison counts a kit pattern built by hand as a difference", () => {
	const owed = screenCompareContent(undefined, []).at(-1) as { text: string };
	assert.match(owed.text, /The kit counts too: a dialog that is not the kit sheet .* a checkbox where a switch belongs, a row whose label is not on the left edge or whose control is not on the right, .* go back to the worker like any other difference\./);
});

// --- a resumed reviewer run counts (keeb 2026-11-22: two resumes of the reviewer never opened the PR gate) ---

import { configuredAgentModel, pinResidentModel, reviewRun } from "../rules.ts";

test("asyncRunId reads the revived run id from a resume result too", () => {
	assert.equal(asyncRunId("Revived async subagent from cc9f4fa1-512a-4c15-af79-d46c5f28d737.\nRevived run: 9c6caaf0-e517-4e2d-a64d-ab940e80dac3\nAgent: reviewer"), "9c6caaf0-e517-4e2d-a64d-ab940e80dac3");
	assert.equal(asyncRunId("Revived run: 9c6caaf0"), undefined, "a short id is not a run id");
});

test("defaultRunText reads only what the run wrote since it started: a revived run's reply, not the chain before it", () => {
	const root = mkdtempSync(join(tmpdir(), "guard-runs-"));
	const session = join(root, "session.jsonl");
	const line = (role: string, ts: string, text: string) => JSON.stringify({ type: "message", timestamp: ts, message: { role, content: [{ type: "text", text }] } });
	writeFileSync(
		session,
		[line("user", "2026-11-22T23:00:30.000Z", "Task: review"), line("assistant", "2026-11-22T23:10:00.000Z", "## Review\n- Finding: P1 gap\n- Merge verdict: BLOCK"), line("user", "2026-11-22T23:25:35.000Z", "Task: You are reviving"), line("assistant", "2026-11-22T23:34:00.000Z", "## Review\n- Merge verdict: OK")].join("\n") + "\n",
	);
	const put = (id: string, body: Record<string, unknown>) => {
		mkdirSync(join(root, id), { recursive: true });
		writeFileSync(join(root, id, "status.json"), JSON.stringify({ state: "complete", sessionFile: session, ...body }));
	};
	put("first", { startedAt: Date.parse("2026-11-22T23:00:29.000Z") });
	put("revived", { startedAt: Date.parse("2026-11-22T23:25:33.000Z") });
	put("undated", {});
	assert.equal(reviewBlocked(defaultRunText("first", root) ?? ""), true, "the first run's own reply ended BLOCK, whatever came after in the shared file");
	assert.equal(defaultRunText("revived", root), "## Review\n- Merge verdict: OK");
	assert.equal(reviewBlocked(defaultRunText("revived", root) ?? ""), false);
	assert.match(defaultRunText("undated", root) ?? "", /BLOCK[\s\S]*OK/, "without a start time the whole file is read, as before");
});

test("reviewRun finds the repo of the pending reviewer run a resume names, by full id or the 8-char prefix the model uses", () => {
	const L = "cc9f4fa1-512a-4c15-af79-d46c5f28d737";
	const X = "9c6caaf0-e517-4e2d-a64d-ab940e80dac3";
	const branch = [
		{ type: "message", message: { role: "toolResult", toolCallId: "w", isError: false, content: [{ type: "text", text: `Async: worker [${X}]` }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "r", isError: false, content: [{ type: "text", text: `Async: reviewer [${L}]\n${reviewPendingMark("/home/m/workspace/apps/keeb", "a".repeat(40), L)}` }] } },
	];
	assert.deepEqual(reviewRun(branch, L), { dir: "/home/m/workspace/apps/keeb", runId: L });
	assert.deepEqual(reviewRun(branch, "cc9f4fa1"), { dir: "/home/m/workspace/apps/keeb", runId: L });
	assert.equal(reviewRun(branch, X), undefined, "a worker run is not a review");
	assert.equal(reviewRun(branch, "cc9f"), undefined, "too short to name a run");
	assert.equal(reviewRun(branch, 7), undefined);
});

test("configuredAgentModel is the agent's override in settings.json, else the subagents default", () => {
	const settings = { subagents: { agentOverrides: { reviewer: { model: "spark/qwen3.8-flash-next" } }, defaultModel: "spark/qwen3.6-35b-a3b-sglang" } };
	assert.equal(configuredAgentModel(settings, "reviewer"), "spark/qwen3.8-flash-next");
	assert.equal(configuredAgentModel(settings, "worker"), "spark/qwen3.6-35b-a3b-sglang");
	assert.equal(configuredAgentModel({}, "worker"), undefined);
	assert.equal(configuredAgentModel(undefined, "worker"), undefined);
});

test("pinResidentModel: a subagent runs on a model llama-swap already has loaded, never on one that swaps the session's out", () => {
	const settings = { subagents: { agentOverrides: { reviewer: { model: "spark/qwen3.8-flash-next" } }, defaultModel: "spark/qwen3.8-flash-next" } };
	// The caller's model, when loaded, stays.
	const keep: Record<string, unknown> = { agent: "reviewer", model: "spark/qwen3.8-27b-pi" };
	pinResidentModel(keep, settings, ["qwen3.8-27b-pi", "qwen3.6-35b-a3b-sglang"], "spark/qwen3.8-27b-pi");
	assert.equal(keep.model, "spark/qwen3.8-27b-pi");
	// The configured model, when loaded, applies as pi-subagents would (the caller's unloaded one is dropped).
	const configured: Record<string, unknown> = { agent: "reviewer", model: "spark/inkling-2-mini" };
	pinResidentModel(configured, settings, ["qwen3.8-flash-next"], "spark/flash-auto");
	assert.equal(configured.model, undefined);
	// Neither loaded: the session's own model, when loaded (keeb 2026-11-22: Inkling session, Flash-Next reviewer, 8 swaps).
	const session: Record<string, unknown> = { agent: "reviewer" };
	pinResidentModel(session, settings, ["inkling-2-mini"], "spark/inkling-2-mini");
	assert.equal(session.model, "spark/inkling-2-mini");
	const worker: Record<string, unknown> = { agent: "worker" };
	pinResidentModel(worker, settings, ["inkling-2-mini"], "spark/inkling-2-mini");
	assert.equal(worker.model, "spark/inkling-2-mini", "workers follow the same rule");
	// The session's model is virtual or unloaded: the first loaded model.
	const first: Record<string, unknown> = { agent: "reviewer" };
	pinResidentModel(first, settings, ["qwen3.8-27b-pi", "qwen3.6-35b-a3b-sglang"], "spark/pair-auto");
	assert.equal(first.model, "spark/qwen3.8-27b-pi");
	// Nothing loaded (or the lookup failed): nothing pinned, pi-subagents decides.
	const none: Record<string, unknown> = { agent: "reviewer", model: "spark/qwen3.8-27b-pi" };
	pinResidentModel(none, settings, [], "spark/inkling-2-mini");
	assert.equal(none.model, undefined);
});

const previewBranch = (args: Record<string, unknown>, result: Record<string, unknown>) => [
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "p1", name: "preview", arguments: args }] } },
	{ type: "message", message: { role: "toolResult", toolCallId: "p1", toolName: "preview", ...result } },
];

test("previewOpened finds a successful preview call for the app and not for another", () => {
	const branch = previewBranch({ cwd: "~/workspace/apps/fret" }, { isError: false, details: { url: "https://x:10600", kind: "dev" } });
	assert.equal(previewOpened(branch, `${home}/workspace/apps/fret`, home, home), true);
	assert.equal(previewOpened(branch, `${home}/workspace/apps/keeb`, home, home), false);
	assert.equal(previewOpened([], `${home}/workspace/apps/fret`, home, home), false);
	const rel = previewBranch({ dir: "src" }, { isError: false, details: { url: "u" } });
	assert.equal(previewOpened(rel, `${home}/workspace/apps/fret`, `${home}/workspace/apps/fret`, home), true, "relative to cwd");
	const file = previewBranch({ file: `${home}/workspace/apps/fret/dist/index.html` }, { details: { url: "u" } });
	assert.equal(previewOpened(file, `${home}/workspace/apps/fret`, home, home), true, "a file under the app");
});

test("an errored or stopped preview does not count", () => {
	const dir = `${home}/workspace/apps/fret`;
	assert.equal(previewOpened(previewBranch({ cwd: dir }, { isError: true, details: { url: "u" } }), dir, home, home), false);
	assert.equal(previewOpened(previewBranch({ cwd: dir }, { isError: false, details: { stopped: true } }), dir, home, home), false);
});

test("previewOpened: a preview call that names no path counts for the session cwd", () => {
	const dir = `${home}/workspace/apps/fret`;
	const branch = previewBranch({}, { isError: false, details: { url: "u" } });
	assert.equal(previewOpened(branch, dir, dir, home), true);
	assert.equal(previewOpened(branch, `${home}/workspace/apps/keeb`, dir, home), false);
});

test("previewNote names the dir and the tool call, asks a question after the review and keeps pr-wait after a pr", () => {
	const review = previewNote("/h/workspace/apps/fret", "review");
	const pr = previewNote("/h/workspace/apps/fret", "pr");
	for (const n of [review, pr]) {
		assert.ok(n.startsWith(PREVIEW_NOTE_MARK));
		assert.match(n, /preview\(\{ cwd: "\/h\/workspace\/apps\/fret" \}\)/);
	}
	assert.match(review, /ask him in one line whether it looks right, then end your turn/);
	assert.match(pr, /the PR is open, but Michael hasn't seen it live/);
	assert.match(pr, /start pr-wait with the bg_bash tool/);
	assert.match(pr, /together with the PR link/);
});

{
	// The plan-4 review's case: an app edit, a live preview opened, a short reply with no question.
	const fret = `${home}/workspace/apps/fret`;
	const user = { role: "user", content: "make the fret dots a touch bigger" };
	const edit = { role: "assistant", content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: `${fret}/src/app.css` } }] };
	const edited = { role: "toolResult", toolCallId: "e1", toolName: "edit", content: [{ type: "text", text: "ok" }] };
	const call = { role: "assistant", content: [{ type: "toolCall", id: "p1", name: "preview", arguments: { cwd: "~/workspace/apps/fret" } }] };
	const opened = (extra: Record<string, unknown>) => ({ role: "toolResult", toolCallId: "p1", toolName: "preview", content: [{ type: "text", text: "Preview open at https://x" }], ...extra });
	const reply = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The live preview is open; have a look." }] };
	const nudges = (run: any[]) => [shouldNudge(run), shouldNudgePr(run, appsNeedingPr(run, home, () => true))];

	test("a run that opened a live preview is waiting on Michael: no stall nudge, no PR nudge", () => {
		assert.deepEqual(nudges([user, edit, edited, call, opened({ details: { url: "https://x" } }), reply]), [false, false]);
	});

	test("without the preview, or with an errored one, both nudges still fire", () => {
		const ran = { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "npm test" } }] };
		const passed = { role: "toolResult", toolCallId: "b1", toolName: "bash", content: [{ type: "text", text: "ok" }] };
		assert.deepEqual(nudges([user, edit, edited, ran, passed, reply]), [true, true]);
		assert.deepEqual(nudges([user, edit, edited, call, opened({ isError: true, details: { url: "https://x" } }), reply]), [true, true]);
		assert.deepEqual(nudges([user, edit, edited, call, opened({ isError: false, details: {} }), reply]), [true, true], "no url, no preview");
	});

	test("a run that opened a live preview gets no to-do nudge either; without the preview it does", () => {
		const said = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The preview is open in the Preview tab. Have a look." }] };
		const open = [{ id: 1, subject: "Bigger fret dots", status: "pending" }];
		assert.equal(shouldNudgeTodos([user, edit, edited, call, opened({ details: { url: "https://x" } }), said], open), false);
		const ran = { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "npm test" } }] };
		const passed = { role: "toolResult", toolCallId: "b1", toolName: "bash", content: [{ type: "text", text: "ok" }] };
		assert.equal(shouldNudgeTodos([user, edit, edited, ran, passed, said], open), true);
	});
}

test("shipOverride: Michael's ship instruction after a review of the app opens the gate without another review", () => {
	const dir = "/home/m/workspace/apps/keeb";
	const other = "/home/m/workspace/apps/fret";
	const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
	const res = (text: string) => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } });
	const block = () => "## Review\n**Merge verdict: BLOCK**";
	const blocked = res(reviewBlockedMark(dir, "bbbbbbb"));
	const asyncBlocked = res(reviewPendingMark(dir, "aaaaaaa", "run-a"));
	// keeb 2026-11-23: five BLOCK passes, "Just ship the pr and we can fix that later.", and `pr` was still refused.
	assert.equal(shipOverride([user("fix it"), blocked, user("Just ship the pr and we can fix that later.")], dir), true);
	assert.equal(shipOverride([user("fix it"), asyncBlocked, user("ship it")], dir, () => "complete", block), true, "an async BLOCK read from its transcript");
	assert.equal(shipOverride([user("fix it"), res(reviewMark(dir, "ccccccc")), user("open the PR")], dir), true, "a review that passed counts too");
	// Without a review of this app before it, a ship message is the ordinary request and the gate stays shut.
	assert.equal(shipOverride([user("ship it")], dir), false);
	assert.equal(shipOverride([user("fix it"), res(reviewBlockedMark(other, "bbbbbbb")), user("ship it")], dir), false, "another app's review");
	// Only his last message counts, and only when it says to ship.
	assert.equal(shipOverride([user("fix it"), blocked, user("ship it"), user("hold on, the fold test is wrong")], dir), false);
	assert.equal(shipOverride([user("fix it"), blocked, user("the P1 is right, fix it here")], dir), false);
	assert.equal(shipOverride([user("fix it"), blocked, user("the shipping label is cut off")], dir), false, "ship as a noun is not an order");
	// With the override, there is no gap to report.
	assert.equal(reviewGap([user("fix it"), blocked, user("Just ship the pr and we can fix that later.")], dir), undefined);
	assert.match(reviewGap([user("fix it"), blocked], dir) ?? "", /The gate stays shut until he says to ship/);
});

test("inheritedChanges: the first call into a dirty app records the files; Michael keeping them releases the mark", () => {
	const dir = "/home/m/workspace/apps/keeb";
	const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
	const res = (text: string) => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } });
	const note = inheritedNote(dir, ["src/lesson/ladder.ts", "test/ladder.test.ts"]);
	assert.match(note, /^\[pi-guard\] inherited changes \/home\/m\/workspace\/apps\/keeb: src\/lesson\/ladder\.ts, test\/ladder\.test\.ts\n/);
	assert.match(note, /predate this session/);
	assert.match(note, /nuke/);
	assert.deepEqual(inheritedChanges([user("fix the sync bug"), res(note)], dir), ["src/lesson/ladder.ts", "test/ladder.test.ts"]);
	assert.deepEqual(inheritedChanges([user("fix the sync bug"), res(note)], "/home/m/workspace/apps/fret"), [], "another app");
	assert.deepEqual(inheritedChanges([user("fix the sync bug")], dir), []);
	// His word after the note releases them: keep/commit/include/yes, or naming a file.
	assert.deepEqual(inheritedChanges([user("fix it"), res(note), user("keep them, they're mine")], dir), []);
	assert.deepEqual(inheritedChanges([user("fix it"), res(note), user("yes")], dir), []);
	assert.deepEqual(inheritedChanges([user("fix it"), res(note), user("the ladder.ts change stays")], dir), []);
	assert.deepEqual(inheritedChanges([user("fix it"), res(note), user("no, I nuked that. stash it")], dir), ["src/lesson/ladder.ts", "test/ladder.test.ts"]);
	assert.deepEqual(inheritedChanges([user("fix it"), user("keep them"), res(note)], dir), ["src/lesson/ladder.ts", "test/ladder.test.ts"], "a keep before the note is not an answer to it");
});

test("a commit in an app with inherited changes is blocked until Michael keeps or sets them aside", () => {
	const files = ["src/lesson/ladder.ts"];
	const blocked = bash(`${app}git add -A && git commit -m "feat: focus letters"`, env({ inherited: () => files }));
	assert.match(blocked ?? "", /^Blocked: src\/lesson\/ladder\.ts (?:was|were) changed before this session/);
	assert.match(blocked ?? "", /git stash push/);
	assert.equal(bash(`${app}git commit -m x`, env({ inherited: () => [] })), undefined);
	assert.equal(bash(`${app}git status`, env({ inherited: () => files })), undefined, "only commits are gated");
	assert.equal(bash(`${app}git stash push -m inherited -- src/lesson/ladder.ts`, env({ inherited: () => files })), undefined, "setting them aside is the way out");
});

test("discardOrder: Michael's last message says to throw the work away", () => {
	const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
	for (const t of ["nevermind. nuke this work.", "nuke it", "discard all of this", "scrap this and start over", "throw this away", "nuke this branch", "discard these changes"]) assert.equal(discardOrder([user("fix it"), user(t)]), true, t);
	for (const t of ["nuke the old dialog", "discard the stale pick in remapFor", "nuke this file and move it to src/ui", "nevermind", "it should be the eye-closed icon"]) assert.equal(discardOrder([user("fix it"), user(t)]), false, t);
	assert.equal(discardOrder([user("nuke it"), user("actually keep going")]), false, "only his last message counts");
});

test("under a discard order, reverting is allowed and committing or shipping dirty work is blocked", () => {
	const ordered = env({ dirty: () => true, discardOrdered: () => true });
	assert.equal(bash(`${app}git checkout -- .`, ordered), undefined, "the revert Michael asked for");
	assert.equal(bash(`${app}git reset --hard HEAD`, ordered), undefined);
	assert.match(bash(`${app}git commit -am "wip"`, ordered) ?? "", /^Blocked: Michael said to discard this work/);
	assert.match(bash(`${app}node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/keeb --title x --body y`, ordered) ?? "", /^Blocked: Michael said to discard this work/);
	assert.equal(bash(`${app}git commit -am "wip"`, env({ dirty: () => false, discardOrdered: () => true })), undefined, "a clean tree has nothing left to discard");
	assert.equal(bash(`${app}git checkout -- .`, env({ dirty: () => true, discardOrdered: () => false })), REASONS.discard, "without the order the discard rule stands");
});

test("branchRequests: every message of Michael's since the last PR opened, oldest first, verbatim", () => {
	const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
	const call = (command: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command } }] } });
	assert.equal(branchRequests([]), undefined);
	assert.equal(branchRequests([user("fix the orphan bug"), user("board+map pair. carry over the settings row."), user("ship it")]), "fix the orphan bug\n\nboard+map pair. carry over the settings row.\n\nship it");
	// A PR opened on the branch closes the request: what came before it was shipped and reviewed.
	const prCall = call("cd ~/workspace/apps/keeb && node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/keeb --title x --body y");
	const opened = { type: "message", message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: 'RESULT {"ok":true}' }] } };
	const refused = { type: "message", message: { role: "toolResult", toolCallId: "c", isError: true, content: [{ type: "text", text: "Blocked: run the reviewer before opening the PR." }] } };
	assert.equal(branchRequests([user("hide the keyboard"), prCall, opened, user("eye icon please"), user("eye-closed, not eye-off")]), "eye icon please\n\neye-closed, not eye-off");
	assert.equal(branchRequests([user("hide the keyboard"), prCall, opened]), undefined, "nothing asked since the PR");
	assert.equal(branchRequests([user("hide the keyboard"), prCall, refused, user("ship it")]), "hide the keyboard\n\nship it", "a refused pr opened nothing");
	// Pictures are left out; a long history keeps the latest messages whole.
	assert.equal(branchRequests([user("a"), { type: "message", message: { role: "user", content: [{ type: "image", data: "x" }, { type: "text", text: "b" }] } }]), "a\n\nb");
	const long = branchRequests([user("x".repeat(1500)), user("y".repeat(1500))], 2000) ?? "";
	assert.match(long, /^\[earlier messages cut\]\n\ny{1500}$/);
});

test("reviewHeader: the request is every message since the PR; spec sentences the diff adds are not named behaviors", () => {
	const scope = { dir: "/home/m/workspace/apps/keeb", base: "0123456789ab", baseFrom: "main" as const, diffPath: "/tmp/keeb-review.diff" };
	const h = reviewHeader({ ...scope, files: [{ path: "src/app/repair.ts", added: "9", removed: "0" }, { path: "docs/spec.md", added: "25", removed: "0" }], request: "fix the orphan bug\n\nship it" });
	assert.match(h, /\[Michael's messages on this branch, verbatim, oldest first\. The parent's summary below may have lost part of them\.\]\nfix the orphan bug\n\nship it\n/);
	assert.match(h, /Sentences `docs\/spec\.md` gains in this diff are the diff's own description of itself, not behaviors Michael named: check them against the code, but a missing test for one of them is a P2 note, never a BLOCK\./);
	assert.match(h, /A named behavior with no such test is a P1 finding and the merge verdict is BLOCK/);
});

test("reviewHeader: a style-only diff gets the kit rules and no test-per-behavior rule", () => {
	const scope = { dir: "/home/m/workspace/apps/keeb", base: "0123456789ab", baseFrom: "main" as const, diffPath: "/tmp/keeb-review.diff", kit: "## Style rules\n\n- Use only kit components." };
	const style = reviewHeader({ ...scope, files: [{ path: "src/ui/app-styles.ts", added: "1", removed: "2" }, { path: "src/ui/icons.ts", added: "4", removed: "0" }, { path: "e2e/keyboard-toggle.spec.ts", added: "12", removed: "0" }], request: "the buttons shouldn't change background on hover" });
	assert.match(style, /\[Style-only diff: src\/ui\/app-styles\.ts, src\/ui\/icons\.ts\. The look was checked on the screenshot; no test is required for a style, and a missing one is not a finding\. Check that the change is what Michael asked for and that it keeps the kit rules below\.\]/);
	assert.doesNotMatch(style, /named behavior with no such test/);
	assert.match(style, /\[Kit rules\./);
	assert.match(style, /the buttons shouldn't change background on hover/);
	const logic = reviewHeader({ ...scope, files: [{ path: "src/ui/app-styles.ts", added: "1", removed: "2" }, { path: "src/app/boards.ts", added: "4", removed: "0" }], request: "hover" });
	assert.doesNotMatch(logic, /Style-only diff/);
	assert.match(logic, /named behavior with no such test/);
});

test("reviewHeader: where a control sits is a look the screenshot checked, not a behavior that needs a test", () => {
	const scope = { dir: "/home/m/workspace/apps/keeb", base: "0123456789ab", baseFrom: "main" as const, diffPath: "/tmp/keeb-review.diff" };
	const h = reviewHeader({ ...scope, files: [{ path: "src/ui/settings-dialog.ts", added: "3", removed: "0" }, { path: "src/app/diagnostics.ts", added: "129", removed: "0" }], request: 'add a "copy diagnostics" button under settings → account' });
	assert.match(h, /Where a control sits \(which dialog, group or row holds it, what it comes before or after\) is a look, not a behavior: the screenshot gate checked it, so no test is required for placement and a missing one is not a finding\./);
	assert.match(h, /A named behavior with no such test is a P1 finding/);
});

test("shell rewrites of files in the app are blocked like Python ones; reads, scratch files and renames are not", () => {
	for (const c of [
		"sed -i '111d' src/app-main.ts",
		"perl -0pi -e 's/a: string; name: string;/a: string;/' src/app/diagnostics.ts && grep -n name src/app/diagnostics.ts",
		"cat >> test/diagnostics.test.ts <<'EOF'\n\ndescribe(\"x\", () => {\n\tit(\"y\", () => { expect(a).toBe(b); });\n});\nEOF",
		"cat > docs/spec.md <<'EOF'\n# spec\nEOF",
		"head -93 src/app/diagnostics.ts > /tmp/diagnostics.ts && mv /tmp/diagnostics.ts src/app/diagnostics.ts && tail -3 src/app/diagnostics.ts",
		"echo 'export {};' > src/app/empty.ts",
		"cp /tmp/fixed.ts src/app/diagnostics.ts",
	]) assert.equal(bash(app + c), REASONS.rewrite, c);
	assert.equal(checkToolCall("bash", { command: "sed -i 's/a/b/' src/ui/icons.ts" }, env({ cwd: "/home/m/workspace/apps/keeb/src" }))?.reason, REASONS.rewrite, "relative to the cwd");
	for (const c of [
		"npm test 2>&1 | tail -5",
		"npm run typecheck 2>&1 | tail -10 && npm test 2>&1 | grep -E 'Tests |Test Files '",
		"sed -n '1,40p' src/app-main.ts | grep -n '^$'",
		"sed -n 100,130p src/atproto/records.ts | grep -n 'SessionRow' | head",
		"git diff main > /tmp/keeb-review.diff",
		"node scripts/report.ts > /tmp/report.json",
		"mv src/app/old.ts src/app/new.ts",
		"cp src/app/a.ts src/app/b.ts",
		"sed -i 's/a/b/' /tmp/scratch.ts",
		"grep -rn 'x => y' src | head; echo 'done' > /dev/null",
		"awk 'NF==0{print NR\": \"$0}' src/app-main.ts",
		"cat <<'EOF'\nconst f = (a: number) => a > 1;\nEOF",
	]) assert.equal(bash(app + c), undefined, c);
	assert.equal(bash("sed -i 's/a/b/' ~/notes/todo.md"), undefined, "outside any app or repo");
});

test("a pr with a timeout behind a shut review gate reports the gate, and the timeout with it", () => {
	const command = app + "node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/keeb --title 'feat: x' --body 'y'";
	const shut = env({ reviewed: () => false, codeChanged: () => true });
	const reason = checkToolCall("bash", { command, timeout: 600 }, shut)?.reason ?? "";
	assert.ok(reason.startsWith(REASONS.review), reason);
	assert.match(reason, /no timeout/);
	assert.equal(checkToolCall("bash", { command, timeout: 600 }, env({ reviewed: () => true }))?.reason, REASONS.prTimeout, "open gate: the timeout alone");
	assert.equal(checkToolCall("bash", { command }, shut)?.reason, REASONS.review, "no timeout: the gate alone");
});

test("kitPatterns reads the design system page into patterns keyed by article and heading, code unescaped", () => {
	const html = `<article id="forms"><h2>Forms</h2><p class="lead">grid</p><figure class="ex"><div class="demo">x</div><figcaption>Label <code>left</code>, control right.</figcaption>
<pre data-lang="html"><button class="icon-btn copy" aria-label="Copy snippet" title="Copy"></button><code>&lt;div class=&quot;form&quot;&gt;&amp;&lt;/div&gt;</code></pre></figure>
<h3>Pattern CSS</h3><pre data-lang="css"><button class="icon-btn copy"></button><code>.form { display: grid; }</code></pre></article>
<article id="overlays"><h2>Overlays</h2><p class="lead">no code here</p>
	<h3>Settings dialog</h3><figure class="ex"><div class="card"><h3>Streak</h3></div><figcaption>The form pattern inside a sheet.</figcaption><pre data-lang="html"><code>&lt;tk-sheet heading=&quot;Settings&quot;&gt;&lt;/tk-sheet&gt;</code></pre></figure></article>`;
	const p = kitPatterns(html);
	assert.deepEqual(p.map((x) => x.id), ["forms", "forms/pattern-css", "overlays/settings-dialog"]);
	assert.deepEqual(p[0], { id: "forms", title: "Forms", caption: "Label left, control right.", code: [{ lang: "html", text: '<div class="form">&</div>' }] });
	assert.deepEqual(p[1], { id: "forms/pattern-css", title: "Forms: Pattern CSS", caption: undefined, code: [{ lang: "css", text: ".form { display: grid; }" }] });
	assert.equal(p[2].title, "Overlays: Settings dialog");
	assert.equal(p[2].code[0].text, '<tk-sheet heading="Settings"></tk-sheet>');
	// The real page parses, and every pattern the guard hands out is on it with code.
	const real = kitPatterns(readFileSync(new URL("../../kit/demo/index.html", import.meta.url), "utf8"));
	for (const id of ["buttons", "forms", "forms/pattern-css", "feedback/toasts", "feedback/status", "feedback/notices", "feedback/progress", "feedback/empty-and-loading-states", "overlays/settings-dialog", "overlays/confirm", "lists", "lists/cards", "data", "icons"]) {
		assert.ok(real.some((x) => x.id === id && x.code.length), id);
	}
	assert.ok(real.find((x) => x.id === "overlays/settings-dialog")!.code[0].text.startsWith('<tk-sheet heading="Settings"'));
});

test("kitPatternIds picks the patterns an edit touches, in the page's order", () => {
	assert.deepEqual(kitPatternIds("src/ui/settings-dialog.ts", 'html`<dialog class="settings"><div class="form"><label>Goal</label><input></div></dialog>`'), ["forms", "forms/pattern-css", "overlays/settings-dialog", "overlays/confirm"]);
	assert.deepEqual(kitPatternIds("src/ui/icons.ts", 'export const EYE = svg`<path d="M2 12s3-7 10-7"/>`'), ["buttons", "icons"]);
	assert.deepEqual(kitPatternIds("src/ui/boards.ts", 'html`<div class="rows">${rows.map((r) => html`<div class="row"><button class="icon-btn" aria-label="x">${PENCIL_ICON}</button></div>`)}</div>`'), ["buttons", "lists", "lists/cards", "icons"]);
	assert.deepEqual(kitPatternIds("src/ui/insights.ts", "const chart = d3.select(svg)"), ["data"]);
	assert.deepEqual(kitPatternIds("src/ui/app-main.ts", 'toast("saved"); html`<div class="empty">nothing yet</div>`'), ["feedback/toasts", "feedback/empty-and-loading-states"]);
	assert.deepEqual(kitPatternIds("src/lesson/ladder.ts", "export function next(stats: StatMap) { return 1; }"), []);
	assert.deepEqual(kitPatternIds("src/ui/app-styles.ts", ".row { gap: 4px }"), ["lists", "lists/cards"]);
	// A page bootstrapping on the kit, and a Lit element: the start and layout sections.
	assert.deepEqual(kitPatternIds("index.html", '<link rel="stylesheet" href="https://kit.thatsit.app/kit.css"><tk-shell><tk-header></tk-header></tk-shell>'), ["start", "layout"]);
	assert.deepEqual(kitPatternIds("app-main.js", 'import { LitElement, html } from "https://kit.thatsit.app/lit.js";'), ["start/a-component"]);
});

test("kitDepartures names what an edit builds by hand", () => {
	const d = kitDepartures('html`<dialog open><svg viewBox="0 0 24 24"><path d="M1 1"/></svg></dialog>` + css`a { color: #ff0000; font-family: Nunito; border-radius: 8px; }`');
	assert.equal(d.length, 5, d.join("\n"));
	assert.match(d[0], /`<dialog>` by hand.*`tk-sheet`/);
	assert.match(d[1], /Pasted SVG.*kit/);
	assert.match(d[2], /#ff0000/);
	assert.match(d[3], /font-family/);
	assert.match(d[4], /border-radius/);
	assert.deepEqual(kitDepartures('html`<tk-sheet heading="Settings"><div class="form"><a href="#f-level">x</a></div></tk-sheet>` + css`.x { border-radius: var(--radius); color: var(--primary); }`'), []);
});

test("kitPatternNote carries the departures first, then each pattern's code", () => {
	const note = kitPatternNote([{ id: "overlays/settings-dialog", title: "Overlays: Settings dialog", caption: "The form pattern inside a sheet.", code: [{ lang: "html", text: "<tk-sheet></tk-sheet>" }] }], ["This edit builds a `<dialog>` by hand."]);
	assert.match(note, /^\[pi-guard\] Kit patterns for this change, from https:\/\/kit\.thatsit\.app\/ \(no fetch needed\)\. Copy them as they are; app CSS never re-declares a kit class, and the reviewer checks against them\.\n- This edit builds a `<dialog>` by hand\.\n\n## Overlays: Settings dialog\nThe form pattern inside a sheet\.\n```html\n<tk-sheet><\/tk-sheet>\n```$/);
	assert.match(kitPatternNote([], ["x"]), /^\[pi-guard\] Kit patterns[^\n]*\n- x$/);
});

test("absPath resolves ~ and relative paths", () => {
	assert.equal(absPath("~/workspace/apps/keeb/src/a.ts", "/x", home), "/home/m/workspace/apps/keeb/src/a.ts");
	assert.equal(absPath("src/a.ts", "/home/m/workspace/apps/keeb", home), "/home/m/workspace/apps/keeb/src/a.ts");
	assert.equal(absPath("/tmp/a.ts", "/x", home), "/tmp/a.ts");
});

test("a commit on main or master is blocked until the work has a branch; a switch earlier in the same command counts", () => {
	const trunk = env({ onTrunk: () => true, repoRoot: (p) => (p.startsWith("/home/m/workspace/website") ? "/home/m/workspace/website" : undefined) });
	assert.equal(bash(`${app}git commit -m "x"`, trunk), REASONS.commitMain);
	assert.equal(bash(`${app}git add -A && git commit -qm "x"`, trunk), REASONS.commitMain);
	assert.equal(bash("cd ~/workspace/website && git commit -m x", trunk), REASONS.commitMain, "any repo under ~/workspace");
	assert.equal(bash(`${app}git switch -c drop-vault && git commit -m x`, trunk), undefined);
	assert.equal(bash(`${app}git checkout -b drop-vault && git add -A && git commit -m x`, trunk), undefined);
	assert.equal(bash(`${app}git commit -m x && git switch -c late`, trunk), REASONS.commitMain, "the switch comes after the commit");
	assert.equal(bash(`${app}git commit -m x`, env({ onTrunk: () => false })), undefined);
	assert.equal(bash(`${app}git commit -m x`), undefined, "not checked when the env does not say");
	assert.equal(bash(`${app}git log --oneline -3`, trunk), undefined);
	assert.match(REASONS.commitMain, /git switch -c/);
	assert.match(REASONS.commitMain, /git branch -f (?:main|<trunk>) origin\//, "says how to move commits already made on main");
});

test("the orchestrator's ledger append is not app code, whatever its heredoc body says", () => {
	const o = env({ orchestrator: true, repoRoot: (p) => (p.startsWith("/home/m/workspace/website") ? "/home/m/workspace/website" : undefined) });
	const note = "cd ~/workspace/website && cat >> .superpowers/sdd/plan/progress.md <<'EOF'\n### Ruling\nThe brief mandated deleting package.json (Node >=18 floor); re-add a minimal `package.json` with `{\"type\":\"module\"}`.\nEOF\necho ok";
	assert.equal(bash(note, o), undefined);
	assert.equal(bash("cd ~/workspace/website && cat >> package.json <<'EOF'\n{}\nEOF", o), REASONS.orchestrator, "the redirect target is still checked");
});

test("exhaustedRun: a run whose status says hard-blocked, by full id or prefix; anything else is not", () => {
	const root = mkdtempSync(join(tmpdir(), "guard-runs-"));
	const id = "e54202e3-d925-4f16-8263-842b8681414c";
	mkdirSync(join(root, id));
	writeFileSync(join(root, id, "status.json"), JSON.stringify({ state: "complete", toolBudget: { hard: 40, outcome: "hard-blocked", hardReachedAt: 40 } }));
	const ok = "26a4f07b-d08e-4b1b-9293-8e39c15742ad";
	mkdirSync(join(root, ok));
	writeFileSync(join(root, ok, "status.json"), JSON.stringify({ state: "complete", toolBudget: { hard: 40, outcome: "within-budget" } }));
	assert.equal(exhaustedRun(id, root), true);
	assert.equal(exhaustedRun("e54202e3", root), true, "the 8-character prefix the model passes");
	assert.equal(exhaustedRun(ok, root), false);
	assert.equal(exhaustedRun("00000000", root), false);
	assert.equal(exhaustedRun("e54", root), false, "too short to name a run");
	assert.equal(exhaustedRun(id, join(root, "missing")), false);
	assert.match(REASONS.resumeExhausted, /fresh run of the same agent/);
});

test("a Python script that only ticks a plan or appends to the SDD ledger is not a rewrite; one that touches code is", () => {
	const tick = `${app}python3 - <<'PY'\np='docs/superpowers/plans/2026-11-24-kit-rebuild.md'\ns=open(p).read()\nopen(p,'w').write(s.replace('- [ ] **Step 1','- [x] **Step 1'))\nPY`;
	assert.equal(planRewrite(tick), true);
	assert.equal(bash(tick), undefined);
	const ledger = `${app}python3 -c "open('.superpowers/sdd/plan/progress.md','a').write('ok')"`;
	assert.equal(bash(ledger), undefined);
	const code = `${app}python3 - <<'PY'\np='src/app-main.ts'\ns=open(p).read()\nopen(p,'w').write(s.replace('a','b'))\nPY`;
	assert.equal(planRewrite(code), false);
	assert.equal(bash(code), REASONS.rewrite);
	const both = `${app}python3 - <<'PY'\nfor p in ['docs/superpowers/plans/x.md','src/a.ts']:\n  open(p,'w').write('x')\nPY`;
	assert.equal(bash(both), REASONS.rewrite, "a code path anywhere keeps the block");
	assert.equal(planRewrite("open(p,'w').write(s)"), false, "no literal path: not exempt");
});
