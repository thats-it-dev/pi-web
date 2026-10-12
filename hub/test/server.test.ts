import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { applyEvent } from "../../shared/src/reducer.ts";
import type { HubConfig } from "../src/config.ts";
import { Registry } from "../src/registry.ts";
import { Viewers } from "../src/push-watch.ts";
import { createHubServer } from "../src/server.ts";
import { SessionIndex } from "../src/sessions.ts";
import { FakeHandle } from "./support/fake-handle.ts";
import { call, openSse } from "./support/http.ts";

const root = mkdtempSync(join(tmpdir(), "pi-web-server-"));
const work = join(root, "work");
const sessions = join(root, "sessions");
mkdirSync(work);
mkdirSync(join(sessions, "--work--"), { recursive: true });
writeFileSync(
	join(sessions, "--work--", "2026-10-07T00-00-00-000Z_disk-1.jsonl"),
	`${JSON.stringify({ type: "session", version: 3, id: "disk-1", timestamp: "2026-10-07T00:00:00.000Z", cwd: work })}\n` +
		`${JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "x", message: { role: "user", content: "from the cli", timestamp: 1 } })}\n`,
);

const cfg: HubConfig = {
	port: 0,
	hostname: "hub.test:7878",
	allowedLogin: "me@github",
	allowedOrigins: ["https://pi.thatsit.app"],
	idleMinutes: 20,
	maxHeadless: 6,
	piBin: "pi",
	dev: false,
	dataDir: root,
};
const GOOD = { origin: "https://pi.thatsit.app", host: "hub.test:7878", "tailscale-user-login": "me@github" };

const handles = new Map<string, FakeHandle>();
let n = 0;
let nextId: string | null = null; // forces the id of the next started handle
const index = new SessionIndex(sessions);
const registry = new Registry({
	factory: {
		async startRpc(o) {
			const id = nextId ?? (o.sessionFile ? "disk-1" : `new-${++n}`);
			nextId = null;
			const h = new FakeHandle(id, o.cwd, o.sessionFile ?? null);
			handles.set(id, h);
			return h;
		},
	},
	lookup: index,
	maxHeadless: 6,
	idleMs: 60_000,
});
const logs: string[] = [];
const viewers = new Viewers();
const server = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: work, log: (m) => logs.push(m), viewers });
let port = 0;
before(async () => {
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as AddressInfo).port;
});
after(() => {
	server.closeAllConnections();
	server.close();
});

test("rejects requests from other origins or without the tailnet identity", async () => {
	assert.equal((await call(port, "GET", "/api/sessions", { ...GOOD, origin: "https://evil.example" })).status, 403);
	assert.equal((await call(port, "GET", "/api/sessions", { ...GOOD, "tailscale-user-login": undefined })).status, 403);
	assert.equal((await call(port, "GET", "/api/sessions", { ...GOOD, host: "evil.example" })).status, 403);
	assert.ok(logs.some((l) => l.includes("origin https://evil.example")));
});

test("answers CORS preflight only for the app's origin", async () => {
	const ok = await call(port, "OPTIONS", "/api/sessions", { origin: "https://pi.thatsit.app", host: "hub.test:7878" });
	assert.equal(ok.status, 204);
	assert.equal(ok.headers["access-control-allow-origin"], "https://pi.thatsit.app");
	assert.equal((await call(port, "OPTIONS", "/api/sessions", { origin: "https://evil.example" })).status, 403);
});

test("health reports the caller's login and the hub version", async () => {
	const r = await call(port, "GET", "/api/health", GOOD);
	assert.equal(r.status, 200);
	assert.deepEqual(r.body, { ok: true, login: "me@github", hubVersion: "0.1.0-test", vapidPublicKey: null });
	assert.equal(r.headers["access-control-allow-origin"], "https://pi.thatsit.app");
});

test("lists sessions from disk and new live sessions without files", async () => {
	registry.close("disk-1");
	let r = await call(port, "GET", "/api/sessions", GOOD);
	const disk = r.body.sessions.find((s: { id: string }) => s.id === "disk-1");
	assert.equal(disk.firstPrompt, "from the cli");
	assert.equal(disk.live, false);
	assert.equal(disk.file, undefined, "file paths stay on the hub");
	const created = await call(port, "POST", "/api/sessions", GOOD, { cwd: work });
	assert.equal(created.status, 200);
	r = await call(port, "GET", "/api/sessions", GOOD);
	const fresh = r.body.sessions.find((s: { id: string }) => s.id === created.body.sessionId);
	assert.equal(fresh.live, true);
	assert.equal(fresh.cwd, work);
});

test("new sessions need an existing folder; ~ expands to home", async () => {
	const bad = await call(port, "POST", "/api/sessions", GOOD, { cwd: join(root, "missing") });
	assert.equal(bad.status, 400);
	assert.match(bad.body.error, /Not a folder/);
	const home = await call(port, "POST", "/api/sessions", GOOD, { cwd: "~" });
	assert.equal(home.status, 200);
	assert.equal(handles.get(home.body.sessionId)?.cwd, work);
});

test("a relative folder is resolved against home, not the hub's working directory", async () => {
	mkdirSync(join(work, "proj"), { recursive: true });
	const r = await call(port, "POST", "/api/sessions", GOOD, { cwd: "proj" });
	assert.equal(r.status, 200);
	assert.equal(handles.get(r.body.sessionId)?.cwd, join(work, "proj"));
	const tilde = await call(port, "POST", "/api/sessions", GOOD, { cwd: "~/proj/" });
	assert.equal(handles.get(tilde.body.sessionId)?.cwd, join(work, "proj"));
	const missing = await call(port, "POST", "/api/sessions", GOOD, { cwd: "nope" });
	assert.equal(missing.status, 400);
	assert.equal(missing.body.error, `Not a folder: ${join(work, "nope")}`);
});

test("commands: validated, 404 for unknown sessions, forwarded to the session's handle", async () => {
	registry.close("disk-1");
	assert.equal((await call(port, "POST", "/api/sessions/disk-1/commands", GOOD, { type: "rm_rf" })).status, 400);
	assert.equal((await call(port, "POST", "/api/sessions/nope/commands", GOOD, { type: "attach" })).status, 404);
	const r = await call(port, "POST", "/api/sessions/disk-1/commands", GOOD, { type: "prompt", text: "hi", mode: "send" });
	assert.deepEqual(r.body, { result: { ok: true }, sessionId: "disk-1" });
	assert.deepEqual(handles.get("disk-1")?.received.at(-1), { type: "prompt", text: "hi", mode: "send" });
});

test("history reads the file when no process is running", async () => {
	registry.close("disk-1");
	const r = await call(port, "GET", "/api/sessions/disk-1/history", GOOD);
	assert.equal(r.body.live, false);
	assert.equal(r.body.messages[0].content, "from the cli");
	assert.equal((await call(port, "GET", "/api/sessions/nope/history", GOOD)).status, 404);
});

test("a stream waits detached, then attaches when the session starts", async () => {
	registry.close("disk-1");
	const sse = await openSse(port, "/api/sessions/disk-1/stream", GOOD);
	assert.equal((await sse.next((m) => m.type !== undefined)).type, "detached");
	await call(port, "POST", "/api/sessions/disk-1/commands", GOOD, { type: "attach" });
	const snap = await sse.next((m) => m.type === "snapshot");
	assert.equal((snap.snapshot as { sessionId: string }).sessionId, "disk-1");
	handles.get("disk-1")?.push({ type: "notify", message: "hello", level: "info" });
	assert.equal((await sse.next((m) => m.type === "notify")).message, "hello");
	handles.get("disk-1")?.close();
	await sse.next((m) => m.type === "handle_gone");
	await sse.next((m) => m.type === "detached");
	sse.close();
});

test("a stream follows session_changed and re-attaches under the new id", async () => {
	const created = await call(port, "POST", "/api/sessions", GOOD, { cwd: work });
	const from = created.body.sessionId as string;
	const h = handles.get(from) as FakeHandle;
	const sse = await openSse(port, `/api/sessions/${from}/stream`, GOOD);
	assert.equal(((await sse.next((m) => m.type === "snapshot")).snapshot as { sessionId: string }).sessionId, from);
	// What RpcHandle does after fork/clone/new: a snapshot under the new id, then session_changed.
	h.sessionId = "moved-1";
	h.push({ type: "snapshot", snapshot: h.snapshot() });
	h.fire({ type: "session_changed", from, to: "moved-1" });
	assert.equal(((await sse.next((m) => m.type === "snapshot")).snapshot as { sessionId: string }).sessionId, "moved-1");
	h.close();
	await sse.next((m) => m.type === "handle_gone");
	await sse.next((m) => m.type === "detached");
	// A process for the old id must not grab the stream; one for the new id does.
	nextId = from;
	await call(port, "POST", "/api/sessions", GOOD, { cwd: work });
	nextId = "moved-1";
	await call(port, "POST", "/api/sessions", GOOD, { cwd: work });
	const again = await sse.next((m) => m.type === "snapshot");
	assert.equal((again.snapshot as { sessionId: string }).sessionId, "moved-1");
	assert.equal(sse.messages.filter((m) => (m as { type?: string }).type === "snapshot").length, 0);
	registry.close(from);
	registry.close("moved-1");
	sse.close();
});

test("a stream moves to the terminal when it takes over a session the app had open", async () => {
	await call(port, "POST", "/api/sessions/disk-1/commands", GOOD, { type: "attach" });
	const rpc = handles.get("disk-1") as FakeHandle;
	rpc.deferGone = true; // like RpcHandle: handle_gone comes when the child exits, later
	const sse = await openSse(port, "/api/sessions/disk-1/stream", GOOD);
	assert.equal(((await sse.next((m) => m.type === "snapshot")).snapshot as { handleKind: string }).handleKind, "rpc");
	const term = new FakeHandle("disk-1", work, null, { kind: "bridge", pid: 31337 });
	assert.equal(registry.attachBridge(term), "attached");
	rpc.goneNow();
	await sse.next((m) => m.type === "detached");
	assert.equal(((await sse.next((m) => m.type === "snapshot")).snapshot as { handleKind: string }).handleKind, "bridge");
	term.leave();
	await sse.next((m) => m.type === "detached");
	sse.close();
});

test("reconnecting mid-reply gets the partial message and running tools in the snapshot", async () => {
	registry.close("disk-1");
	await call(port, "POST", "/api/sessions/disk-1/commands", GOOD, { type: "attach" });
	const h = handles.get("disk-1") as FakeHandle;
	applyEvent(h.conv, { type: "agent_start" });
	applyEvent(h.conv, { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } });
	applyEvent(h.conv, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
	applyEvent(h.conv, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
	const sse = await openSse(port, "/api/sessions/disk-1/stream", GOOD);
	const snap = await sse.next((m) => m.type === "snapshot");
	const conv = (snap.snapshot as { conv: { streaming: boolean; partial: { content: Array<{ text: string }> }; tools: Record<string, { running: boolean; name: string }> } }).conv;
	assert.equal(conv.streaming, true);
	assert.equal(conv.tools.t1.running, true);
	assert.equal(conv.tools.t1.name, "bash");
	assert.equal(conv.partial.content[0].text, "Hel");
	sse.close();
});

test("the events stream relays session state changes, and counts as the app being open", async () => {
	assert.equal(viewers.watching(), false);
	const sse = await openSse(port, "/api/events", GOOD);
	assert.equal(viewers.watching(), true);
	const created = await call(port, "POST", "/api/sessions", GOOD, { cwd: work });
	const m = await sse.next((x) => x.type === "session_state" && x.sessionId === created.body.sessionId);
	assert.equal(m.live, true);
	sse.close();
	for (let i = 0; i < 100 && viewers.watching(); i++) await new Promise((r) => setTimeout(r, 10));
	assert.equal(viewers.watching(), false);
});

test("an unreadable export is an error response and the hub keeps serving", async () => {
	mkdirSync(join(root, "exports", "dir.html"), { recursive: true });
	const r = await call(port, "GET", "/api/exports/dir.html", GOOD);
	assert.equal(r.status, 404);
	assert.equal((await call(port, "GET", "/api/health", GOOD)).status, 200);
});

test("a readable export downloads as an attachment", async () => {
	mkdirSync(join(root, "exports"), { recursive: true });
	writeFileSync(join(root, "exports", "ok.html"), "<p>hi</p>");
	const res = await new Promise<{ status: number; disposition: string | undefined; text: string }>((resolve, reject) => {
		httpGet({ host: "127.0.0.1", port, path: "/api/exports/ok.html", headers: GOOD }, (r) => {
			let text = "";
			r.setEncoding("utf8");
			r.on("data", (c) => (text += c));
			r.on("end", () => resolve({ status: r.statusCode ?? 0, disposition: r.headers["content-disposition"], text }));
		}).on("error", reject);
	});
	assert.equal(res.status, 200);
	assert.match(res.disposition ?? "", /attachment/);
	assert.equal(res.text, "<p>hi</p>");
});

test("unknown routes are 404 JSON", async () => {
	const r = await call(port, "GET", "/api/nope", GOOD);
	assert.equal(r.status, 404);
	assert.equal(r.body.error, "Not found");
});
