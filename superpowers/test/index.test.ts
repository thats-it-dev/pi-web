import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import superpowersSwitch, { buildManualSkills, catalog, ENTRY_TYPE, FLOOR_ENTRY, forPi, manualOnly, MARKER, pairMode, PI_NOTES_PAIR, savedState, SOURCE, STATUS_KEY, STATUS_ON, withCatalog } from "../index.ts";

const entry = (on: boolean) => ({ type: "custom", customType: ENTRY_TYPE, data: { on } });

test("savedState: off by default for every session, the last saved switch wins", () => {
	assert.equal(savedState([]), false);
	assert.equal(savedState([{ type: "message" }]), false);
	assert.equal(savedState([entry(true)]), true);
	assert.equal(savedState([entry(true), { type: "message" }, entry(false)]), false);
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
	return { saved, status, handlers, ctx };
}

test("session start: a brand-new pi-web code session stays off and writes nothing (no default-on since 2026-11-25)", () => {
	const { saved, status, handlers, ctx } = startWith({ PI_WEB_SESSION_TYPE: "code" }, []);
	assert.equal(status[STATUS_KEY], undefined);
	assert.deepEqual(saved, []);
	assert.equal(handlers.context({ messages: [] }, ctx), undefined, "off: no message is added");
});

test("session start: chat sessions and subagent children stay off too", () => {
	assert.deepEqual(startWith({ PI_WEB_SESSION_TYPE: "chat" }, []).saved, []);
	assert.deepEqual(startWith({ PI_WEB_SESSION_TYPE: "code", PI_SUBAGENT_CHILD: "1" }, []).saved, []);
});

test("catalog: name, description and path of each manual skill; empty for a missing dir", () => {
	const dir = mkdtempSync(join(tmpdir(), "sp-cat-"));
	for (const [n, d] of [["brainstorming", "Use when design questions are open"], ["writing-plans", "Use when you have a spec"]]) {
		mkdirSync(join(dir, n));
		writeFileSync(join(dir, n, "SKILL.md"), `---\nname: ${n}\ndescription: "${d}"\n---\nbody`);
	}
	const text = catalog(dir);
	assert.ok(text.startsWith(MARKER));
	assert.match(text, new RegExp(`- brainstorming: Use when design questions are open \\(${join(dir, "brainstorming", "SKILL.md").replace(/[/.]/g, "\\$&")}\\)`));
	assert.match(text, /do the work/);
	assert.ok(text.length < 1200, `the catalog stays short: ${text.length} chars`);
	assert.equal(catalog(join(dir, "missing")), "");
});

test("manualOnly adds disable-model-invocation to the frontmatter, once", () => {
	assert.equal(manualOnly("---\nname: a\ndescription: b\n---\nbody\n"), "---\nname: a\ndescription: b\ndisable-model-invocation: true\n---\nbody\n");
	assert.equal(manualOnly("---\nname: a\ndisable-model-invocation: false\n---\nx"), "---\nname: a\ndisable-model-invocation: true\n---\nx");
});

test("buildManualSkills: copies SKILL.md manual-only, links the rest, skips a dir without SKILL.md", () => {
	const src = mkdtempSync(join(tmpdir(), "sp-src-"));
	mkdirSync(join(src, "brainstorming"));
	writeFileSync(join(src, "brainstorming", "SKILL.md"), "---\nname: brainstorming\n---\nbody");
	writeFileSync(join(src, "brainstorming", "visual.md"), "v");
	mkdirSync(join(src, "notes"));
	writeFileSync(join(src, "notes", "README.md"), "n");
	const out = join(mkdtempSync(join(tmpdir(), "sp-out-")), "manual");
	assert.equal(buildManualSkills(src, out), out);
	assert.match(readFileSync(join(out, "brainstorming", "SKILL.md"), "utf8"), /disable-model-invocation: true/);
	assert.equal(lstatSync(join(out, "brainstorming", "visual.md")).isSymbolicLink(), true);
	assert.equal(existsSync(join(out, "notes")), false);
	assert.equal(buildManualSkills(join(src, "missing"), out), undefined);
});

test("forPi: a note goes after the frontmatter; no note, no change", () => {
	const md = "---\nname: executing-plans\n---\nbody";
	assert.match(forPi("executing-plans", md, PI_NOTES_PAIR), /^---\nname: executing-plans\n---\n\n> \*\*In pi \(orchestrator\):\*\*/);
	assert.equal(forPi("executing-plans", md), md);
	assert.equal(forPi("brainstorming", md, PI_NOTES_PAIR), md);
});

test("the vendored skills: five, manual, no route to the skills that were left out, brainstorming not mandatory", () => {
	assert.deepEqual(readdirSync(SOURCE).sort(), ["brainstorming", "executing-plans", "systematic-debugging", "test-driven-development", "writing-plans"]);
	const out = join(mkdtempSync(join(tmpdir(), "sp-real-")), "manual");
	buildManualSkills(undefined, out);
	for (const name of readdirSync(out)) {
		const md = readFileSync(join(out, name, "SKILL.md"), "utf8");
		assert.match(md, /disable-model-invocation: true/, name);
		assert.doesNotMatch(md, /superpowers:|subagent-driven-development|using-git-worktrees|finishing-a-development-branch|requesting-code-review|verification-before-completion/, name);
	}
	const plans = readFileSync(join(out, "writing-plans", "SKILL.md"), "utf8");
	assert.match(plans, /Use the executing-plans skill to implement this plan/);
	assert.match(plans, /Does it capture what you want\?/);
	assert.doesNotMatch(plans, /Which execution approach/);
	assert.doesNotMatch(readFileSync(join(out, "brainstorming", "SKILL.md"), "utf8"), /You MUST/);
	assert.match(readFileSync(join(out, "executing-plans", "SKILL.md"), "utf8"), /Michael merges/);
});

test("the orchestrator notes: writing-plans gets the parallel-group line, executing-plans the orchestration rules", () => {
	const out = join(mkdtempSync(join(tmpdir(), "sp-pair-")), "manual");
	buildManualSkills(undefined, out, PI_NOTES_PAIR);
	assert.match(readFileSync(join(out, "writing-plans", "SKILL.md"), "utf8"), /\*\*Parallel group:\*\* <letter>/);
	const exec = readFileSync(join(out, "executing-plans", "SKILL.md"), "utf8");
	assert.match(exec, /never run `npm ci` or `npm install` in a worktree/);
	assert.match(exec, /never edit, write or delete app code yourself/);
	assert.match(exec, /stopReason `length`/);
});

test("withCatalog: after the compaction summary, once", () => {
	const msgs = [{ role: "compactionSummary", content: "s" }, { role: "user", content: "hi" }];
	const out = withCatalog(msgs, `${MARKER}\n- a`);
	assert.deepEqual(out.map((m) => m.role), ["compactionSummary", "user", "user"]);
	assert.equal(withCatalog(out, `${MARKER}\n- a`), out);
});

test("the switch: command saves and shows the state; off by default with no message", () => {
	const handlers: Record<string, (e: any, c: any) => any> = {};
	let command: ((args: string, ctx: any) => unknown) | undefined;
	const saved: unknown[] = [];
	const status: Record<string, string | undefined> = {};
	const ctx = { sessionManager: { getBranch: () => [] }, ui: { setStatus: (k: string, t: string | undefined) => (status[k] = t), notify: () => {} } };
	superpowersSwitch({ on: (e, h) => (handlers[e] = h), registerCommand: (_n, o) => (command = o.handler), appendEntry: (t, d) => saved.push([t, d]) });
	handlers.session_start({ reason: "startup" }, ctx);
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

test("pairMode reads only the orchestrate flag", () => {
	assert.equal(pairMode({ defaultModel: "spark/pair-auto", subagents: { defaultModel: "spark/qwen3.6-35b-a3b-sglang" } }), false, "the pair's model names mean nothing since 2026-11-25");
	assert.equal(pairMode({ defaultModel: "flash-auto", subagents: { defaultModel: "spark/qwen3.6-35b-a3b-sglang" } }), false);
	assert.equal(pairMode({ defaultModel: "spark/pair-auto" }), false);
	assert.equal(pairMode(undefined), false);
	assert.equal(pairMode({ defaultModel: "spark/flash-auto", subagents: { defaultModel: "spark/qwen3.8-flash-next", orchestrate: true } }), true);
	assert.equal(pairMode({ defaultModel: "spark/pair-auto", subagents: { defaultModel: "spark/qwen3.6-35b-a3b-sglang", orchestrate: false } }), false);
	assert.equal(pairMode({ subagents: { orchestrate: "yes" } }), false);
});
