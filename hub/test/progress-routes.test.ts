import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import type { HubConfig } from "../src/config.ts";
import { Registry } from "../src/registry.ts";
import { createHubServer } from "../src/server.ts";
import { SessionIndex } from "../src/sessions.ts";
import { applyEvent, createConversation } from "../../shared/src/reducer.ts";
import { FakeHandle } from "./support/fake-handle.ts";
import { call } from "./support/http.ts";

const FIX = join(import.meta.dirname, "../../shared/test/fixtures/progress");
const root = mkdtempSync(join(tmpdir(), "pi-web-progress-"));
const sessions = join(root, "sessions");
const cfg: HubConfig = {
	port: 0, internalPort: 0, hostname: "hub.test:7878", allowedLogin: "me@github", allowedOrigins: ["https://pi.thatsit.app"],
	idleMinutes: 20, maxHeadless: 6, piBin: "pi", dev: false, approvalMode: "manual", push: true, ringProfileUrl: "", dataDir: root,
};
const GOOD = { origin: "https://pi.thatsit.app", host: "hub.test:7878", "tailscale-user-login": "me@github" };

// A fixture session copied under the temp root, with /FIXTURE rewritten to it. Returns [id, file, text].
function seed(name: string, slug: string, edit: (text: string) => string = (t) => t): { id: string; file: string } {
	const text = edit(readFileSync(join(FIX, name), "utf8").replaceAll("/FIXTURE", root));
	const id = JSON.parse(text.split("\n")[0]).id as string;
	const file = join(sessions, slug, `2026-11-08T22-11-04-000Z_${id}.jsonl`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	return { id, file };
}
const put = (file: string, text: string) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
};

const goal = seed("goal.jsonl", "--goal--");
const bg = seed("subagent-bg.jsonl", "--bg--");
const fg = seed("subagent-fg.jsonl", "--fg--");
const todo = seed("todo.jsonl", "--todo--");
// The background fixture with a crafted runId that tries to climb out of the session dir.
const BG_RUN = "d43cb787-c955-4641-b6b1-e3cd32980cb8";
const evil = seed("subagent-bg.jsonl", "--evil--", (t) => t.replaceAll(`"runId": "${BG_RUN}"`, '"runId": "../../escape"').replaceAll(`"asyncId": "${BG_RUN}"`, '"asyncId": "../../escape"').replace(/01a1bd37-0fd5-7621-b114-82eba7609d10/, "evil-0000"));
const asyncDir = join(root, "tmp/pi-subagents/async-subagent-runs/d43cb787-c955-4641-b6b1-e3cd32980cb8");
const statusFile = join(asyncDir, "status.json");
const setStatus = (v: unknown) => put(statusFile, typeof v === "string" ? v : JSON.stringify(v));

// Plan files live under the todo session's cwd.
const cwd = JSON.parse(readFileSync(todo.file, "utf8").split("\n")[0]).cwd as string;
mkdirSync(join(cwd, "docs/superpowers/plans"), { recursive: true });
writeFileSync(join(cwd, "docs/superpowers/plans/p.md"), "# plan\n");
writeFileSync(join(cwd, "docs/superpowers/plans/big.md"), "x".repeat(600 * 1024));
writeFileSync(join(cwd, "notes.txt"), "hi");
writeFileSync(join(root, "secret.md"), "secret");
writeFileSync(join(root, "outside.md"), "outside");
symlinkSync(join(root, "secret.md"), join(cwd, "docs/superpowers/plans/evil.md"));

const index = new SessionIndex(sessions);
// A started session is a FakeHandle with the id and file of the session it resumes.
const idOf = (file?: string) => /_([^_]+)\.jsonl$/.exec(file ?? "")?.[1] ?? "x";
const registry = new Registry({ factory: { startRpc: async (o) => new FakeHandle(idOf(o.sessionFile), o.cwd, o.sessionFile ?? null) }, lookup: index, maxHeadless: 6, idleMs: 60_000 });
const server = createHubServer({ cfg, registry, index, version: "t", home: root, log: () => {} });
let port = 0;
before(async () => {
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as AddressInfo).port;
});
after(() => {
	server.closeAllConnections();
	server.close();
	rmSync(root, { recursive: true, force: true });
});
const get = (p: string) => call(port, "GET", p, GOOD);

test("goal: the complete goal, null for a session without one, 404 for an unknown id", async () => {
	const r = await get(`/api/sessions/${goal.id}/goal`);
	assert.equal(r.status, 200);
	assert.equal(r.body.goal.status, "complete");
	assert.deepEqual((await get(`/api/sessions/${todo.id}/goal`)).body, { goal: null });
	assert.equal((await get("/api/sessions/nope/goal")).status, 404);
});

test("progress routes need the same auth as other routes", async () => {
	assert.equal((await call(port, "GET", `/api/sessions/${goal.id}/goal`, { ...GOOD, "tailscale-user-login": undefined })).status, 403);
});

test("plan: reads a markdown file under the cwd", async () => {
	const r = await get(`/api/sessions/${todo.id}/plan?path=docs/superpowers/plans/p.md`);
	assert.equal(r.status, 200);
	assert.equal(r.body.text, "# plan\n");
	assert.equal(r.body.path, "docs/superpowers/plans/p.md");
	assert.equal(typeof r.body.mtimeMs, "number");
});

test("plan: escapes, non-markdown, symlinks out, oversize and missing all 404", async () => {
	const q = (p: string) => get(`/api/sessions/${todo.id}/plan?path=${encodeURIComponent(p)}`);
	for (const p of ["../outside.md", "docs/../../outside.md", "/etc/hosts", join(root, "outside.md"), join(cwd, "docs/superpowers/plans/evil.md"), "notes.txt", "docs/superpowers/plans/evil.md", "docs/superpowers/plans/big.md", "docs/superpowers/plans/missing.md", "docs/superpowers/plans", "a\0.md", ""]) {
		assert.equal((await q(p)).status, 404, p);
	}
	assert.equal((await get(`/api/sessions/${todo.id}/plan`)).status, 404);
	assert.equal((await get(`/api/sessions/nope/plan?path=p.md`)).status, 404);
});

test("plan: an absolute path inside the cwd reads like a relative one", async () => {
	const abs = join(cwd, "docs/superpowers/plans/p.md");
	const r = await get(`/api/sessions/${todo.id}/plan?path=${encodeURIComponent(abs)}`);
	assert.equal(r.status, 200);
	assert.equal(r.body.text, "# plan\n");
});

const children = async (id: string) => (await get(`/api/sessions/${id}/subagents`)).body.children;

test("subagents: background state comes from status.json", async () => {
	setStatus({ state: "running", startedAt: 100 });
	let c = await children(bg.id);
	assert.equal(c.length, 1);
	assert.equal(c[0].state, "running");
	assert.equal(c[0].startedAt, 100);
	assert.equal(c[0].endedAt, null);
	setStatus({ state: "complete", startedAt: 100, endedAt: 200 });
	c = await children(bg.id);
	assert.equal(c[0].state, "done");
	assert.equal(c[0].endedAt, 200);
	for (const [s, want] of [["queued", "running"], ["failed", "failed"], ["partial", "failed"], ["rejected", "failed"], ["stopped", "stopped"], ["paused", "unknown"]] as const) {
		setStatus({ state: s });
		assert.equal((await children(bg.id))[0].state, want, s);
	}
});

test("subagents: missing, corrupt or odd status.json is unknown", async () => {
	for (const v of ["{", "[]", "null", { state: "weird" }, { state: 7 }, {}]) {
		setStatus(v);
		assert.equal((await children(bg.id))[0].state, "unknown", JSON.stringify(v));
	}
	rmSync(asyncDir, { recursive: true });
	assert.equal((await children(bg.id))[0].state, "unknown");
});

test("subagents: foreground children keep their derived state and 404 for unknown sessions", async () => {
	const c = await children(fg.id);
	assert.equal(c[0].background, false);
	assert.equal(c[0].state, "done");
	assert.equal((await get("/api/sessions/nope/subagents")).status, 404);
});

const childEntries =
	`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2026-11-08T22:11:24.000Z", cwd })}\n` +
	`${JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "x", message: { role: "user", content: "scan it", timestamp: 1 } })}\n`;

test("child history: a valid key returns the child's messages", async () => {
	const [child] = await children(fg.id);
	assert.ok(child.sessionFile);
	put(child.sessionFile, childEntries);
	const r = await get(`/api/sessions/${fg.id}/subagents/${encodeURIComponent(child.key)}/history`);
	assert.equal(r.status, 200);
	assert.equal(r.body.messages[0].content, "scan it");
	assert.equal(r.body.child.key, child.key);
});

test("child history: unknown, foreign and crafted keys 404", async () => {
	const [mine] = await children(fg.id);
	put(mine.sessionFile, childEntries);
	const [other] = await children(bg.id).catch(() => []) as any[];
	const h = (k: string) => get(`/api/sessions/${fg.id}/subagents/${k}/history`);
	assert.equal((await h("nope%3A0")).status, 404);
	assert.equal((await h("..%2F..%2Fetc%2Fhosts")).status, 404);
	assert.equal((await h(encodeURIComponent(`${mine.toolCallId}:9`))).status, 404);
	assert.equal((await h("%E0%A4%A")).status, 404); // bad percent-encoding
	assert.equal((await get(`/api/sessions/${todo.id}/subagents/${encodeURIComponent(mine.key)}/history`)).status, 404);
	assert.equal((await get(`/api/sessions/nope/subagents/${encodeURIComponent(mine.key)}/history`)).status, 404);
	if (other) assert.equal((await get(`/api/sessions/${fg.id}/subagents/${encodeURIComponent(other.key)}/history`)).status, 404);
});

test("child history: a child with no readable session file is 404", async () => {
	const [child] = await children(fg.id);
	rmSync(child.sessionFile, { force: true });
	assert.equal((await get(`/api/sessions/${fg.id}/subagents/${encodeURIComponent(child.key)}/history`)).status, 404);
});

// A pid that surely names no process: a short child that has already exited.
async function deadPid(): Promise<number> {
	const p = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await new Promise((r) => p.once("exit", r));
	assert.ok(p.pid);
	return p.pid;
}

test("subagents: a queued/running report from a dead runner or past its deadline is unknown", async () => {
	const pid = await deadPid();
	for (const state of ["running", "queued"]) {
		setStatus({ state, pid });
		assert.equal((await children(bg.id))[0].state, "unknown", `${state} dead pid`);
		setStatus({ state, deadlineAt: Date.now() - 1000 });
		assert.equal((await children(bg.id))[0].state, "unknown", `${state} past deadline`);
	}
	// our own pid is alive and a future deadline is fine
	setStatus({ state: "running", pid: process.pid, deadlineAt: Date.now() + 60_000 });
	assert.equal((await children(bg.id))[0].state, "running");
	// a terminal state is kept whatever the pid says
	setStatus({ state: "complete", pid, deadlineAt: 1 });
	assert.equal((await children(bg.id))[0].state, "done");
});

const bgKey = async () => (await children(bg.id))[0].key as string;
const bgHistory = async () => get(`/api/sessions/${bg.id}/subagents/${encodeURIComponent(await bgKey())}/history`);

test("child history: a background child's transcript comes from its status.json", async () => {
	const real = JSON.parse(readFileSync(join(FIX, "bg-run/status.json"), "utf8").replaceAll("/FIXTURE", root));
	rmSync(asyncDir, { recursive: true, force: true });
	assert.equal((await bgHistory()).status, 404); // nothing recorded and nothing written yet
	setStatus(real);
	assert.equal((await children(bg.id))[0].sessionFile, real.steps[0].sessionFile);
	assert.equal((await bgHistory()).status, 404); // named but not written yet
	put(real.steps[0].sessionFile, childEntries);
	const r = await bgHistory();
	assert.equal(r.status, 200);
	assert.equal(r.body.messages[0].content, "scan it");
	// the top-level sessionFile serves when steps[] has none
	setStatus({ state: "running", sessionFile: real.sessionFile });
	assert.equal((await bgHistory()).status, 200);
	rmSync(real.steps[0].sessionFile);
	rmSync(asyncDir, { recursive: true, force: true });
});

test("child history: a background child's transcript comes from the derived run layout", async () => {
	rmSync(asyncDir, { recursive: true, force: true });
	const derived = join(bg.file.slice(0, -".jsonl".length), BG_RUN, "run-0", "session.jsonl");
	assert.equal((await bgHistory()).status, 404);
	put(derived, childEntries);
	const r = await bgHistory();
	assert.equal(r.status, 200);
	assert.equal(r.body.messages[0].content, "scan it");
	rmSync(derived);
});

test("child history: a runId with ../ never leaves the session dir", async () => {
	rmSync(asyncDir, { recursive: true, force: true });
	const [c] = await children(evil.id);
	assert.equal(c.runId, "../../escape");
	const target = join(evil.file.slice(0, -".jsonl".length), "../../escape", "run-0", "session.jsonl");
	put(target, childEntries);
	assert.equal((await get(`/api/sessions/${evil.id}/subagents/${encodeURIComponent(c.key)}/history`)).status, 404);
	rmSync(target);
});

test("child history: a running foreground child with no recorded sessionFile reads the derived path (runId from partialResult)", async () => {
	const evs = readFileSync(join(FIX, "subagent-fg.rpc-events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const end = evs.findIndex((e) => e.type === "tool_execution_end");
	const h = (await registry.ensure(fg.id)) as FakeHandle;
	try {
		const conv = createConversation();
		for (const e of evs.slice(0, end)) applyEvent(conv, e);
		h.conv = conv;
		const [c] = await children(fg.id);
		assert.equal(c.state, "running");
		assert.equal(c.sessionFile, null);
		assert.equal(c.runId, "b47e8aef-3f75-4224-8e21-10f05486f2e4");
		const url = `/api/sessions/${fg.id}/subagents/${encodeURIComponent(c.key)}/history`;
		const derived = join(fg.file.slice(0, -".jsonl".length), c.runId, "run-0", "session.jsonl");
		rmSync(derived, { force: true });
		assert.equal((await get(url)).status, 404); // the child hasn't written yet
		put(derived, childEntries);
		const r = await get(url);
		assert.equal(r.status, 200);
		assert.equal(r.body.messages[0].content, "scan it");
		assert.equal(r.body.child.state, "running");
	} finally {
		registry.close(fg.id);
	}
});
