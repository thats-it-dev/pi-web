import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import superpowersSwitch, { bootstrap, buildManualSkills, forPi, initialState, pairMode, PI_NOTES_PAIR, catalog, ENTRY_TYPE, FLOOR_ENTRY, manualOnly, savedState, STATUS_KEY, STATUS_ON, withBootstrap } from "../index.ts";

const entry = (on: boolean) => ({ type: "custom", customType: ENTRY_TYPE, data: { on } });

test("savedState: the last saved switch on the branch, off by default", () => {
	assert.equal(savedState([], {}), false);
	assert.equal(savedState([entry(true)], {}), true);
	assert.equal(savedState([entry(true), { type: "message" }, entry(false)], {}), false);
});

test("savedState: default on for a code child, off otherwise, an entry always wins", () => {
	assert.equal(savedState([], { PI_WEB_SESSION_TYPE: "code" }), true);
	assert.equal(savedState([], { PI_WEB_SESSION_TYPE: "chat" }), false);
	assert.equal(savedState([], {}), false);
	assert.equal(savedState([entry(false)], { PI_WEB_SESSION_TYPE: "code" }), false);
	assert.equal(savedState([entry(true)], { PI_WEB_SESSION_TYPE: "chat" }), true);
	assert.equal(savedState([], { PI_WEB_SESSION_TYPE: "code", PI_SUBAGENT_CHILD: "1" }), false, "a subagent child never starts on");
	assert.equal(savedState([{ type: "message" }], { PI_WEB_SESSION_TYPE: "code" }), false, "an existing session is left alone");
});

test("initialState: a default only for a brand-new code session, never a child or an existing session", () => {
	assert.equal(initialState([], { PI_WEB_SESSION_TYPE: "code" }), true);
	assert.equal(initialState([{ type: "custom", customType: "other" }], { PI_WEB_SESSION_TYPE: "code" }), true);
	assert.equal(initialState([], { PI_WEB_SESSION_TYPE: "chat" }), null);
	assert.equal(initialState([], {}), null);
	assert.equal(initialState([], { PI_WEB_SESSION_TYPE: "code", PI_SUBAGENT_CHILD: "1" }), null);
	assert.equal(initialState([{ type: "message" }], { PI_WEB_SESSION_TYPE: "code" }), null);
	assert.equal(initialState([entry(false)], { PI_WEB_SESSION_TYPE: "code" }), null);
});

function startWith(env: Record<string, string>, branch: unknown[]) {
	const handlers: Record<string, (e: any, c: any) => any> = {};
	const saved: unknown[] = [];
	const status: Record<string, string | undefined> = {};
	superpowersSwitch({ on: (e, h) => (handlers[e] = h), registerCommand: () => {}, appendEntry: (t, d) => saved.push([t, d]) });
	const ctx = { sessionManager: { getBranch: () => branch }, ui: { setStatus: (k: string, t: string | undefined) => (status[k] = t), notify: () => {} } };
	const keys = ["PI_WEB_SESSION_TYPE", "PI_SUBAGENT_CHILD"];
	const before = keys.map((k) => process.env[k]);
	for (const k of keys) delete process.env[k];
	Object.assign(process.env, env);
	try {
		handlers.session_start({ reason: "startup" }, ctx);
	} finally {
		keys.forEach((k, i) => (before[i] === undefined ? delete process.env[k] : (process.env[k] = before[i])));
	}
	return { saved, status };
}

test("session start: an existing code session with messages and no switch entry stays off, writes nothing", () => {
	const { saved, status } = startWith({ PI_WEB_SESSION_TYPE: "code" }, [{ type: "message" }]);
	assert.equal(status[STATUS_KEY], undefined);
	assert.deepEqual(saved, []);
});

test("session start: a brand-new chat session stays off and writes nothing", () => {
	const { saved, status } = startWith({ PI_WEB_SESSION_TYPE: "chat" }, []);
	assert.equal(status[STATUS_KEY], undefined);
	assert.deepEqual(saved, []);
});

test("session start: a subagent child of a code session stays off and writes nothing", () => {
	const { saved, status } = startWith({ PI_WEB_SESSION_TYPE: "code", PI_SUBAGENT_CHILD: "1" }, []);
	assert.equal(status[STATUS_KEY], undefined);
	assert.deepEqual(saved, []);
});

test("session start in a code child with an empty branch turns superpowers on", () => {
	const { saved, status } = startWith({ PI_WEB_SESSION_TYPE: "code" }, []);
	assert.equal(status[STATUS_KEY], STATUS_ON);
	assert.deepEqual(saved, [[ENTRY_TYPE, { on: true }], [FLOOR_ENTRY, { level: "medium" }]], "the default is written into the session");
});

test("catalog: name, description and path of each manual skill, not using-superpowers", () => {
	const dir = mkdtempSync(join(tmpdir(), "sp-cat-"));
	for (const [n, d] of [["brainstorming", "Use before creative work"], ["using-superpowers", "boot"]]) {
		mkdirSync(join(dir, n));
		writeFileSync(join(dir, n, "SKILL.md"), `---\nname: ${n}\ndescription: "${d}"\n---\nbody`);
	}
	const text = catalog(dir);
	assert.match(text, new RegExp(`- brainstorming: Use before creative work \\(${join(dir, "brainstorming", "SKILL.md").replace(/[/.]/g, "\\$&")}\\)`));
	assert.doesNotMatch(text, /using-superpowers/);
	assert.equal(catalog(join(dir, "missing")), "");
});

test("manualOnly adds disable-model-invocation to the frontmatter, once", () => {
	assert.equal(manualOnly("---\nname: a\ndescription: b\n---\nbody\n"), "---\nname: a\ndescription: b\ndisable-model-invocation: true\n---\nbody\n");
	assert.equal(manualOnly("---\nname: a\ndisable-model-invocation: false\n---\nx"), "---\nname: a\ndisable-model-invocation: true\n---\nx");
});

test("buildManualSkills: copies SKILL.md manual-only, links the rest, leaves out the excluded skills", () => {
	const src = mkdtempSync(join(tmpdir(), "sp-src-"));
	for (const n of ["brainstorming", "using-git-worktrees"]) {
		mkdirSync(join(src, n));
		writeFileSync(join(src, n, "SKILL.md"), `---\nname: ${n}\n---\nbody`);
	}
	writeFileSync(join(src, "brainstorming", "visual.md"), "v");
	const out = join(mkdtempSync(join(tmpdir(), "sp-out-")), "manual");
	assert.equal(buildManualSkills(src, out), out);
	assert.match(readFileSync(join(out, "brainstorming", "SKILL.md"), "utf8"), /disable-model-invocation: true/);
	assert.equal(lstatSync(join(out, "brainstorming", "visual.md")).isSymbolicLink(), true);
	assert.equal(existsSync(join(out, "using-git-worktrees")), false);
	assert.equal(buildManualSkills(join(src, "missing"), out), undefined);
});

test("buildManualSkills: links an excluded skill's files for executing-plans, with no SKILL.md so pi never lists it", () => {
	const src = mkdtempSync(join(tmpdir(), "sp-src-"));
	mkdirSync(join(src, "subagent-driven-development", "scripts"), { recursive: true });
	writeFileSync(join(src, "subagent-driven-development", "SKILL.md"), "---\nname: subagent-driven-development\n---\nbody");
	writeFileSync(join(src, "subagent-driven-development", "scripts", "sdd-workspace"), "#!/bin/sh");
	const out = join(mkdtempSync(join(tmpdir(), "sp-out-")), "manual");
	buildManualSkills(src, out);
	assert.equal(lstatSync(join(out, "subagent-driven-development", "scripts")).isSymbolicLink(), true);
	assert.equal(existsSync(join(out, "subagent-driven-development", "SKILL.md")), false);
});

test("forPi: plans run inline; the note goes after the frontmatter and the plan header loses subagent-driven", () => {
	const plans = forPi("writing-plans", "---\nname: writing-plans\n---\n> REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement\n");
	assert.match(plans, /^---\nname: writing-plans\n---\n\n> \*\*In pi:\*\* plans run inline/);
	assert.match(plans, /REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement/);
	assert.match(forPi("executing-plans", "---\nname: executing-plans\n---\nbody"), /never dispatch a `worker` subagent per task/);
	assert.equal(forPi("brainstorming", "---\nname: b\n---\nbody"), "---\nname: b\n---\nbody");
});

test("the real superpowers install: writing-plans keeps no route to subagent-driven-development but the pi note", { skip: !existsSync(join(process.env.HOME ?? "", ".pi/agent/git/github.com/obra/superpowers/skills")) }, () => {
	const out = join(mkdtempSync(join(tmpdir(), "sp-real-")), "manual");
	buildManualSkills(undefined, out);
	const plans = readFileSync(join(out, "writing-plans", "SKILL.md"), "utf8");
	assert.match(plans, /REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement/);
	assert.match(plans, /In pi:\*\* plans run inline/);
	assert.equal(existsSync(join(out, "subagent-driven-development", "scripts", "sdd-workspace")), true);
	assert.equal(existsSync(join(out, "requesting-code-review", "code-reviewer.md")), true);
	assert.equal(existsSync(join(out, "executing-plans", "scripts", "task-start")), true);
});

test("bootstrap: the using-superpowers body with the pi tool mapping; null when superpowers is missing", () => {
	const dir = mkdtempSync(join(tmpdir(), "sp-"));
	mkdirSync(join(dir, "references"));
	writeFileSync(join(dir, "SKILL.md"), "---\nname: using-superpowers\n---\n\nUse skills.\n");
	writeFileSync(join(dir, "references", "pi-tools.md"), "# Pi Tool Mapping\n");
	const text = bootstrap(dir) ?? "";
	assert.match(text, /Use skills\./);
	assert.match(text, /Pi Tool Mapping/);
	assert.doesNotMatch(text, /name: using-superpowers/);
	assert.equal(bootstrap(join(dir, "missing")), null);
});

test("withBootstrap: after the compaction summary, once", () => {
	const msgs = [{ role: "compactionSummary", content: "s" }, { role: "user", content: "hi" }];
	const out = withBootstrap(msgs, "superpowers:using-superpowers bootstrap for pi");
	assert.deepEqual(out.map((m) => m.role), ["compactionSummary", "user", "user"]);
	assert.equal(withBootstrap(out, "superpowers:using-superpowers bootstrap for pi"), out);
});

test("the switch: command saves and shows the state; off by default with no bootstrap", () => {
	const handlers: Record<string, (e: any, c: any) => any> = {};
	let command: ((args: string, ctx: any) => unknown) | undefined;
	const saved: unknown[] = [];
	const status: Record<string, string | undefined> = {};
	const ctx = { sessionManager: { getBranch: () => [] }, ui: { setStatus: (k: string, t: string | undefined) => (status[k] = t), notify: () => {} } };
	superpowersSwitch({ on: (e, h) => (handlers[e] = h), registerCommand: (_n, o) => (command = o.handler), appendEntry: (t, d) => saved.push([t, d]) });
	const keys = ["PI_WEB_SESSION_TYPE", "PI_SUBAGENT_CHILD"];
	const before = keys.map((k) => process.env[k]);
	for (const k of keys) delete process.env[k];
	try {
		handlers.session_start({ reason: "startup" }, ctx);
	} finally {
		keys.forEach((k, i) => (before[i] === undefined ? delete process.env[k] : (process.env[k] = before[i])));
	}
	assert.equal(status[STATUS_KEY], undefined);
	assert.equal(handlers.context({ messages: [] }, ctx), undefined);
	assert.deepEqual(saved, [], "a fresh chat with superpowers off writes nothing");
	command!("on", ctx);
	assert.deepEqual(saved, [[ENTRY_TYPE, { on: true }], [FLOOR_ENTRY, { level: "medium" }]], "on asks flash-auto for a medium reasoning floor");
	assert.equal(status[STATUS_KEY], STATUS_ON);
	saved.length = 0;
	command!("off", ctx);
	assert.deepEqual(saved, [[ENTRY_TYPE, { on: false }], [FLOOR_ENTRY, { level: null }]]);
	assert.equal(status[STATUS_KEY], undefined);
	handlers.session_start({ reason: "resume" }, { ...ctx, sessionManager: { getBranch: () => [entry(true)] } });
	assert.equal(status[STATUS_KEY], STATUS_ON, "a resumed chat restores its switch");
});

test("session start brings an older chat's reasoning floor in line with its switch", () => {
	const handlers: Record<string, (e: any, c: any) => any> = {};
	const saved: unknown[] = [];
	superpowersSwitch({ on: (e, h) => (handlers[e] = h), registerCommand: () => {}, appendEntry: (t, d) => saved.push([t, d]) });
	const ctx = (branch: unknown[]) => ({ sessionManager: { getBranch: () => branch }, ui: { setStatus: () => {}, notify: () => {} } });
	handlers.session_start({ reason: "resume" }, ctx([entry(true)]));
	assert.deepEqual(saved, [[FLOOR_ENTRY, { level: "medium" }]], "on but no floor yet: add it");
	saved.length = 0;
	handlers.session_start({ reason: "resume" }, ctx([entry(true), { type: "custom", customType: FLOOR_ENTRY, data: { level: "medium" } }]));
	assert.deepEqual(saved, [], "already in line");
	handlers.session_start({ reason: "resume" }, ctx([entry(false), { type: "custom", customType: FLOOR_ENTRY, data: { level: "medium" } }]));
	assert.deepEqual(saved, [[FLOOR_ENTRY, { level: null }]], "off with a floor left over: clear it");
});

test("pairMode reads the pair from settings", () => {
	assert.equal(pairMode({ defaultModel: "spark/pair-auto", subagents: { defaultModel: "spark/qwen3.6-35b-a3b-sglang" } }), true);
	assert.equal(pairMode({ defaultModel: "spark/qwen3.8-27b-pi", subagents: { defaultModel: "spark/qwen3.6-35b-a3b-sglang" } }), true);
	assert.equal(pairMode({ defaultModel: "flash-auto", subagents: { defaultModel: "spark/qwen3.6-35b-a3b-sglang" } }), false);
	assert.equal(pairMode({ defaultModel: "spark/pair-auto" }), false);
	assert.equal(pairMode(undefined), false);
});

test("the pair notes replace the inline-only ones", () => {
	const md = "---\nname: executing-plans\n---\nbody";
	assert.match(forPi("executing-plans", md, PI_NOTES_PAIR), /async single|Parallel group/);
	assert.doesNotMatch(forPi("executing-plans", md, PI_NOTES_PAIR), /never dispatch a `worker` subagent/);
	assert.match(forPi("writing-plans", md.replace("executing-plans", "writing-plans"), PI_NOTES_PAIR), /\*\*Parallel group:\*\* <letter>/);
	assert.doesNotMatch(forPi("writing-plans", md.replace("executing-plans", "writing-plans"), PI_NOTES_PAIR), /subagent-driven-development is not available/);
});

test("the pair notes keep the orchestrator out of the code: no npm ci in worktrees, failures go back to a worker, a capped reviewer is re-dispatched", () => {
	const md = "---\nname: executing-plans\n---\nbody";
	const notes = forPi("executing-plans", md, PI_NOTES_PAIR);
	assert.match(notes, /never run `npm ci` or `npm install` in a worktree/);
	assert.match(notes, /never edit, write or delete app code yourself/);
	assert.match(notes, /stopReason `length`/);
	assert.doesNotMatch(notes, /finish the task inline/);
});
