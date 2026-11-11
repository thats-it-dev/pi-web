import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import superpowersSwitch, { bootstrap, buildManualSkills, catalog, ENTRY_TYPE, manualOnly, savedState, STATUS_KEY, STATUS_ON, withBootstrap } from "../index.ts";

const entry = (on: boolean) => ({ type: "custom", customType: ENTRY_TYPE, data: { on } });

test("savedState: the last saved switch on the branch, off by default", () => {
	assert.equal(savedState([]), false);
	assert.equal(savedState([entry(true)]), true);
	assert.equal(savedState([entry(true), { type: "message" }, entry(false)]), false);
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
	superpowersSwitch({ on: (e, h) => (handlers[e] = h), registerCommand: (_n, o) => (command = o.handler), appendEntry: (_t, d) => saved.push(d) });
	handlers.session_start({ reason: "startup" }, ctx);
	assert.equal(status[STATUS_KEY], undefined);
	assert.equal(handlers.context({ messages: [] }, ctx), undefined);
	command!("on", ctx);
	assert.deepEqual(saved, [{ on: true }]);
	assert.equal(status[STATUS_KEY], STATUS_ON);
	command!("off", ctx);
	assert.equal(status[STATUS_KEY], undefined);
	handlers.session_start({ reason: "resume" }, { ...ctx, sessionManager: { getBranch: () => [entry(true)] } });
	assert.equal(status[STATUS_KEY], STATUS_ON, "a resumed chat restores its switch");
});
