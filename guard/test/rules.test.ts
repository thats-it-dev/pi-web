import { test } from "node:test";
import assert from "node:assert/strict";
import { appDir, checkToolCall, fullE2e, MAX_NUDGES, NUDGE_TYPE, REASONS, shouldNudge, type Env } from "../rules.ts";

const home = "/home/m";
const env = (over: Partial<Env> = {}): Env => ({ cwd: home, home, hasScript: () => true, ...over });
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
