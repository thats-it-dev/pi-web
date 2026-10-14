import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApprovalContext, autoAnswer, benignCommand, benignTool, insideFolder } from "../src/auto-approve.ts";

const CWD = "/home/me/project";
const running = (mode: ApprovalContext["mode"], tool: ApprovalContext["tool"] = null): ApprovalContext => ({ mode, running: true, cwd: CWD, tool });
const ALLOW_DENY = { method: "select" as const, options: ["Allow", "Deny"] };

test("auto: a permission select during a turn picks the plain allow option", () => {
	assert.deepEqual(autoAnswer(ALLOW_DENY, running("auto")), { value: "Allow" });
	assert.deepEqual(autoAnswer({ method: "select", options: ["Always allow", "Allow once", "Deny"] }, running("auto")), { value: "Allow once" });
	assert.deepEqual(autoAnswer({ method: "select", options: ["deny", "yes"] }, running("auto")), { value: "yes" });
	assert.deepEqual(autoAnswer({ method: "confirm" }, running("auto")), { confirmed: true });
});

test("manual: nothing is answered", () => {
	assert.equal(autoAnswer(ALLOW_DENY, running("manual", { name: "read", args: { path: "a.ts" } })), null);
	assert.equal(autoAnswer({ method: "confirm" }, running("manual")), null);
});

test("nothing is answered outside a running turn, whatever the mode", () => {
	assert.equal(autoAnswer(ALLOW_DENY, { ...running("auto"), running: false }), null);
	assert.equal(autoAnswer({ method: "confirm" }, { ...running("semi", { name: "read", args: { path: "a.ts" } }), running: false }), null);
});

test("a select with no allow option, and input or editor dialogs, go to the person", () => {
	assert.equal(autoAnswer({ method: "select", options: ["red", "blue"] }, running("auto")), null);
	assert.equal(autoAnswer({ method: "input" }, running("auto")), null);
	assert.equal(autoAnswer({ method: "editor" }, running("auto")), null);
});

test("semi: benign calls are answered, anything else or unknown asks", () => {
	assert.deepEqual(autoAnswer(ALLOW_DENY, running("semi", { name: "read", args: { path: "src/a.ts" } })), { value: "Allow" });
	assert.deepEqual(autoAnswer(ALLOW_DENY, running("semi", { name: "bash", args: { command: "git status" } })), { value: "Allow" });
	assert.equal(autoAnswer(ALLOW_DENY, running("semi", { name: "bash", args: { command: "rm -rf build" } })), null);
	assert.equal(autoAnswer(ALLOW_DENY, running("semi", { name: "write", args: { path: "/etc/hosts" } })), null);
	assert.equal(autoAnswer(ALLOW_DENY, running("semi", null)), null, "no known tool call: ask");
});

test("benignTool: reads, searches, writes and edits inside the folder; nothing outside; no extension tools", () => {
	for (const name of ["read", "ls", "find", "grep", "write", "edit"]) {
		assert.equal(benignTool({ name, args: { path: "src/a.ts" } }, CWD), true, name);
		assert.equal(benignTool({ name, args: { path: `${CWD}/src/a.ts` } }, CWD), true, `${name} absolute`);
		assert.equal(benignTool({ name, args: { path: "../other/a.ts" } }, CWD), false, `${name} outside`);
		assert.equal(benignTool({ name, args: { path: "~/.ssh/id_rsa" } }, CWD), false, `${name} home`);
	}
	assert.equal(benignTool({ name: "find", args: { pattern: "*.ts" } }, CWD), true, "find with no path searches the folder");
	assert.equal(benignTool({ name: "write", args: { content: "x" } }, CWD), false, "write with no path");
	assert.equal(benignTool({ name: "read", args: { path: 42 } }, CWD), false);
	assert.equal(benignTool({ name: "deploy", args: {} }, CWD), false, "extension tool");
});

test("insideFolder", () => {
	assert.equal(insideFolder(".", CWD), true);
	assert.equal(insideFolder("a/../b", CWD), true);
	assert.equal(insideFolder("a/../../b", CWD), false);
	assert.equal(insideFolder("/home/me/project-other/x", CWD), false, "a sibling with the same prefix");
});

test("benignCommand: read-only shell commands only", () => {
	for (const ok of ["ls -la", "cat src/a.ts | head -20", "git status && git diff", "grep -rn foo . | wc -l", "rg TODO src", "git log --oneline -5", "git branch --show-current", "pwd; ls", "find . -name '*.ts'"]) {
		assert.equal(benignCommand(ok), true, ok);
	}
	for (const bad of ["rm -rf build", "npm install", "git push", "git branch -D main", "git checkout .", "ls > out.txt", "cat a; rm b", "echo $(whoami)", "sudo ls", "sed -i 's/a/b/' file", "find . -delete", "find . -exec rm {} \\;", "ls | xargs rm", "curl https://x", "", "   "]) {
		assert.equal(benignCommand(bad), false, bad);
	}
});
