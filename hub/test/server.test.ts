import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { applyEvent } from "../../shared/src/reducer.ts";
import type { ModelInfo } from "../../shared/src/protocol.ts";
import type { HubConfig } from "../src/config.ts";
import { ImageStore } from "../src/images.ts";
import { LastModelStore, type ModelChoice } from "../src/last-model.ts";
import type { Catalog } from "../src/model-catalog.ts";
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
	internalPort: 0,
	hostname: "hub.test:7878",
	allowedLogin: "me@github",
	allowedOrigins: ["https://pi.thatsit.app"],
	idleMinutes: 20,
	maxHeadless: 6,
	piBin: "pi",
	dev: false,
	approvalMode: "manual",
	watchAlert: "auto",
	ringProfileUrl: "",
	dataDir: root,
};
const GOOD = { origin: "https://pi.thatsit.app", host: "hub.test:7878", "tailscale-user-login": "me@github" };

const fakeModel = (id: string, reasoning: boolean): ModelInfo => ({ id, name: id, provider: "fake", reasoning, input: ["text"], contextWindow: 1000, maxTokens: 100 });
const catalogValue: Catalog = {
	models: [fakeModel("fake-a", true), fakeModel("fake-b", false)],
	piDefault: { provider: "fake", modelId: "fake-a", thinking: "medium" },
	levels: { "fake/fake-a": ["off", "low", "medium", "high"], "fake/fake-b": [] },
};
let catalogNow = catalogValue; // swapped for an empty one to stand in for a failed probe
const catalog = { get: async () => catalogNow };
const lastModel = new LastModelStore(join(root, "last-model.json"));

const handles = new Map<string, FakeHandle>();
const starts: Array<{ cwd: string; sessionFile?: string; model?: ModelChoice | null }> = [];
let n = 0;
let nextId: string | null = null; // forces the id of the next started handle
const index = new SessionIndex(sessions);
const registry = new Registry({
	factory: {
		async startRpc(o) {
			starts.push(o);
			const id = nextId ?? (o.sessionFile ? "disk-1" : `new-${++n}`);
			nextId = null;
			const h = new FakeHandle(id, o.cwd, o.sessionFile ?? null);
			h.model = o.model ? (catalogValue.models.find((m) => m.id === o.model?.modelId) ?? null) : null;
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
let updateStatus = { version: "0.1.0-test", commit: "abc1234", behind: 2, latest: "def5678 feat: x", dirty: false, fetchError: null as string | null };
let restarts = 0;
const updater = {
	status: async () => ({ ...updateStatus }),
	apply: async () => ({ output: "Updating abc1234..def5678", commit: "def5678" }),
};
const server = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: work, log: (m) => logs.push(m), viewers, updater, restart: () => restarts++, catalog, lastModel });
// A second hub over the same registry with its own tiny store: the "after a restart" cases.
const freshServer = (images: ImageStore) => createHubServer({ cfg, registry, index, version: "0.1.0-test", home: work, log: () => {}, images });
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

test("defaults report the last pick when it is still available", async () => {
	lastModel.set({ provider: "fake", modelId: "fake-b", thinking: null });
	const r = await call(port, "GET", "/api/defaults", GOOD);
	assert.equal(r.status, 200);
	assert.deepEqual(r.body.model, { provider: "fake", modelId: "fake-b", thinking: null });
	assert.deepEqual(r.body.models.map((m: ModelInfo) => m.id), ["fake-a", "fake-b"]);
	assert.deepEqual(r.body.thinkingLevels, []);
	assert.deepEqual(r.body.levels, catalogValue.levels);
	assert.equal(r.body.approvalMode, "manual");
	assert.equal(r.body.home, work);
});

test("defaults fall back to pi's default when the last pick is gone", async () => {
	lastModel.set({ provider: "fake", modelId: "gone", thinking: "high" });
	const r = await call(port, "GET", "/api/defaults", GOOD);
	assert.deepEqual(r.body.model, catalogValue.piDefault);
	assert.deepEqual(r.body.thinkingLevels, ["off", "low", "medium", "high"]);
});

test("a new session starts on the requested model and records it", async () => {
	lastModel.set({ provider: "fake", modelId: "fake-a", thinking: null });
	const r = await call(port, "POST", "/api/sessions", GOOD, { cwd: work, model: { provider: "fake", modelId: "fake-b" }, thinking: "high" });
	assert.equal(r.status, 200);
	assert.equal(handles.get(r.body.sessionId)?.snapshot().state.model?.id, "fake-b");
	assert.deepEqual(starts.at(-1)?.model, { provider: "fake", modelId: "fake-b", thinking: null }, "a level the model can't do is dropped");
	assert.deepEqual((await call(port, "GET", "/api/defaults", GOOD)).body.model, { provider: "fake", modelId: "fake-b", thinking: null });
	const a = await call(port, "POST", "/api/sessions", GOOD, { cwd: work, model: { provider: "fake", modelId: "fake-a" }, thinking: "high" });
	assert.deepEqual(starts.at(-1)?.model, { provider: "fake", modelId: "fake-a", thinking: "high" });
	assert.equal(handles.get(a.body.sessionId)?.snapshot().state.model?.id, "fake-a");
	assert.deepEqual(lastModel.get(), { provider: "fake", modelId: "fake-a", thinking: "high" });
});

test("an unknown model is a 400", async () => {
	const before = starts.length;
	const r = await call(port, "POST", "/api/sessions", GOOD, { cwd: work, model: { provider: "fake", modelId: "gone" } });
	assert.equal(r.status, 400);
	assert.equal(r.body.error, "Unknown model: fake/gone");
	assert.equal(starts.length, before, "no pi was started");
});

test("with no catalog (a failed probe), the requested model goes to pi as sent", async (t) => {
	catalogNow = { models: [], piDefault: null, levels: {} };
	t.after(() => {
		catalogNow = catalogValue;
	});
	lastModel.set({ provider: "fake", modelId: "fake-b", thinking: null });
	const r = await call(port, "POST", "/api/sessions", GOOD, { cwd: work, model: { provider: "other", modelId: "x" }, thinking: "high" });
	assert.equal(r.status, 200);
	assert.deepEqual(starts.at(-1)?.model, { provider: "other", modelId: "x", thinking: "high" });
	assert.deepEqual(lastModel.get(), { provider: "fake", modelId: "fake-b", thinking: null }, "an unchecked model isn't remembered");
	const bad = await call(port, "POST", "/api/sessions", GOOD, { cwd: work, model: { provider: "other" } });
	assert.equal(bad.status, 400, "the body's shape is still checked");
});

test("sending the default as-is records nothing, so pi's own default can still change", async () => {
	lastModel.set({ provider: "fake", modelId: "gone", thinking: null }); // resolves to pi's default
	const r = await call(port, "POST", "/api/sessions", GOOD, { cwd: work, model: { provider: "fake", modelId: "fake-a" }, thinking: "medium" });
	assert.equal(r.status, 200);
	assert.deepEqual(starts.at(-1)?.model, catalogValue.piDefault);
	assert.deepEqual(lastModel.get(), { provider: "fake", modelId: "gone", thinking: null });
	await call(port, "POST", "/api/sessions", GOOD, { cwd: work, model: { provider: "fake", modelId: "fake-a" }, thinking: "high" });
	assert.deepEqual(lastModel.get(), { provider: "fake", modelId: "fake-a", thinking: "high" }, "a different level is a pick");
});

test("a last model that can't be saved doesn't fail the new session", async (t) => {
	t.mock.method(lastModel, "set", () => {
		throw new Error("disk full");
	});
	const r = await call(port, "POST", "/api/sessions", GOOD, { cwd: work, model: { provider: "fake", modelId: "fake-b" } });
	assert.equal(r.status, 200);
	assert.ok(handles.has(r.body.sessionId));
	assert.ok(logs.some((l) => l.includes("disk full")));
});

test("a new session with no model starts on the resolved default", async () => {
	lastModel.set({ provider: "fake", modelId: "fake-b", thinking: null });
	const r = await call(port, "POST", "/api/sessions", GOOD, { cwd: work });
	assert.equal(handles.get(r.body.sessionId)?.snapshot().state.model?.id, "fake-b");
	lastModel.set({ provider: "fake", modelId: "gone", thinking: null });
	await call(port, "POST", "/api/sessions", GOOD, { cwd: work });
	assert.deepEqual(starts.at(-1)?.model, catalogValue.piDefault);
	assert.deepEqual(lastModel.get(), { provider: "fake", modelId: "gone", thinking: null }, "a default start records nothing");
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

test("an events stream with ?viewing= marks that session as viewed until it closes", async () => {
	const sse = await openSse(port, "/api/events?viewing=s1", GOOD);
	assert.equal(viewers.viewing("s1"), true);
	assert.equal(viewers.viewing("s2"), false);
	sse.close();
	for (let i = 0; i < 100 && viewers.viewing("s1"); i++) await new Promise((r) => setTimeout(r, 10));
	assert.equal(viewers.viewing("s1"), false);
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

test("GET /api/update reports the checkout against master", async () => {
	const r = await call(port, "GET", "/api/update", GOOD);
	assert.equal(r.status, 200);
	assert.deepEqual(r.body, updateStatus);
});

test("POST /api/update pulls, installs and restarts; refuses mid-turn unless forced, and with local changes", async () => {
	nextId = "upd-1";
	await call(port, "POST", "/api/sessions", GOOD, { cwd: work });
	const h = handles.get("upd-1")!;
	h.busy = true;
	const refused = await call(port, "POST", "/api/update", GOOD, {});
	assert.equal(refused.status, 409);
	assert.match(refused.body.error, /1 session is mid-turn/);
	assert.equal(restarts, 0);

	updateStatus = { ...updateStatus, dirty: true };
	h.busy = false;
	const dirty = await call(port, "POST", "/api/update", GOOD, {});
	assert.equal(dirty.status, 409);
	assert.match(dirty.body.error, /local changes/);
	updateStatus = { ...updateStatus, dirty: false };

	h.busy = true;
	const forced = await call(port, "POST", "/api/update", GOOD, { force: true });
	assert.equal(forced.status, 200);
	assert.deepEqual(forced.body, { ok: true, commit: "def5678", output: "Updating abc1234..def5678", restarting: true });
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(restarts, 1);
	assert.ok(logs.some((l) => l.includes("updated to def5678")));
	h.busy = false;
});

test("files searches the session's working directory", async () => {
	mkdirSync(join(work, "src"), { recursive: true });
	writeFileSync(join(work, "src", "mention.ts"), "");
	const r = await call(port, "GET", "/api/sessions/disk-1/files?q=menti", GOOD);
	assert.equal(r.status, 200);
	assert.deepEqual(r.body, { files: [{ path: "src/mention.ts", dir: false }] });
	assert.equal((await call(port, "GET", "/api/sessions/nope/files?q=a", GOOD)).status, 404);
});

// --- images ---
const PNG = Buffer.alloc(40, 7);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(PNG);
PNG.writeUInt32BE(3, 16);
PNG.writeUInt32BE(4, 20);
const PNG_B64 = PNG.toString("base64");
const imgBlock = () => ({ type: "image", data: PNG_B64, mimeType: "image/png" });
const imgResult = () => ({ role: "toolResult", toolCallId: "t1", toolName: "show_image", content: [imgBlock()], isError: false, timestamp: 2 });

function getBytes(path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, any>; body: Buffer }> {
	return new Promise((resolve, reject) => {
		httpGet({ host: "127.0.0.1", port, path, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
		}).on("error", reject);
	});
}

async function liveWithImage(id: string): Promise<FakeHandle> {
	nextId = id;
	const r = await call(port, "POST", "/api/sessions", GOOD, { cwd: work });
	const h = handles.get(r.body.sessionId)!;
	h.conv.messages.push(imgResult() as any);
	return h;
}

test("the session stream sends snapshots and events without image data", async () => {
	const h = await liveWithImage("img-stream");
	const sse = await openSse(port, "/api/sessions/img-stream/stream", GOOD);
	const snap: any = await sse.next((m) => m.type === "snapshot");
	const block = snap.snapshot.conv.messages[0].content[0];
	assert.match(block.ref, /^[0-9a-f]{64}$/);
	assert.equal(block.data, undefined);
	h.push({ type: "event", event: { type: "tool_execution_end", toolCallId: "t2", toolName: "show_image", result: { content: [imgBlock()] }, isError: false } as any });
	const ev: any = await sse.next((m) => m.type === "event");
	assert.equal(ev.event.result.content[0].ref, block.ref);
	assert.ok(!JSON.stringify([snap, ev]).includes(PNG_B64));
	// the handle keeps its data
	assert.equal((h.conv.messages[0] as any).content[0].data, PNG_B64);
	sse.close();
});

test("history returns refs, live and from disk", async () => {
	await liveWithImage("img-hist");
	const live = await call(port, "GET", "/api/sessions/img-hist/history", GOOD);
	assert.match(live.body.messages[0].content[0].ref, /^[0-9a-f]{64}$/);
	assert.ok(!JSON.stringify(live.body).includes(PNG_B64));
	const file = join(sessions, "--work--", "2026-10-07T00-00-00-000Z_img-disk.jsonl");
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: "img-disk", timestamp: "2026-10-07T00:00:00.000Z", cwd: work })}\n` +
			`${JSON.stringify({ type: "message", id: "r1", parentId: null, timestamp: "x", message: imgResult() })}\n`,
	);
	const disk = await call(port, "GET", "/api/sessions/img-disk/history", GOOD);
	assert.equal(disk.body.live, false);
	assert.match(disk.body.messages[0].content[0].ref, /^[0-9a-f]{64}$/);
	assert.ok(!JSON.stringify(disk.body).includes(PNG_B64));
});

test("a ref from the stream is served as bytes", async () => {
	await liveWithImage("img-bytes");
	const hist = await call(port, "GET", "/api/sessions/img-bytes/history", GOOD);
	const ref = hist.body.messages[0].content[0].ref;
	const r = await getBytes(`/api/sessions/img-bytes/images/${ref}`, GOOD);
	assert.equal(r.status, 200);
	assert.deepEqual(r.body, PNG);
	assert.equal(r.headers["content-type"], "image/png");
	assert.equal(r.headers["cache-control"], "private, max-age=31536000, immutable");
	assert.equal(r.headers["x-content-type-options"], "nosniff");
	assert.equal(r.headers["access-control-allow-origin"], GOOD.origin);
});

test("a ref from another session is 404", async () => {
	await liveWithImage("img-own");
	nextId = "img-other"; // a session without that image
	await call(port, "POST", "/api/sessions", GOOD, { cwd: work });
	const hist = await call(port, "GET", "/api/sessions/img-own/history", GOOD);
	const ref = hist.body.messages[0].content[0].ref;
	const r = await call(port, "GET", `/api/sessions/img-other/images/${ref}`, GOOD);
	assert.equal(r.status, 404);
	assert.deepEqual(r.body, { error: "Image not found" });
});

async function withServer<T>(images: ImageStore, fn: (port: number) => Promise<T>): Promise<T> {
	const srv = freshServer(images);
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	try {
		return await fn((srv.address() as AddressInfo).port);
	} finally {
		srv.closeAllConnections();
		srv.close();
	}
}
const jsonl = (id: string, msgs: unknown[]) =>
	[{ type: "session", version: 3, id, timestamp: "2026-10-07T00:00:00.000Z", cwd: work }, ...msgs.map((m, i) => ({ type: "message", id: `r${i}`, parentId: i ? `r${i - 1}` : null, timestamp: "x", message: m }))].map((l) => JSON.stringify(l)).join("\n") + "\n";
const pngOf = (pad: number) => {
	const b = Buffer.alloc(40 + pad, 9);
	PNG.copy(b, 0, 0, 24);
	return b;
};
const resultOf = (b: Buffer) => ({ role: "toolResult", toolCallId: "t", toolName: "show_image", content: [{ type: "image", data: b.toString("base64"), mimeType: "image/png" }], isError: false, timestamp: 2 });

test("a ref is served from the session file when no handle is live", async () => {
	const bytes = pngOf(11); // bytes no other test uses
	writeFileSync(join(sessions, "--work--", "2026-10-07T00-00-00-000Z_img-cold.jsonl"), jsonl("img-cold", [resultOf(bytes)]));
	const ref = (new ImageStore().outgoing("x", resultOf(bytes).content[0]) as any).ref;
	await withServer(new ImageStore(), async (p) => {
		const rr = await new Promise<Buffer>((res, rej) => httpGet({ host: "127.0.0.1", port: p, path: `/api/sessions/img-cold/images/${ref}`, headers: GOOD }, (x) => { const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(Buffer.concat(c))); }).on("error", rej));
		assert.deepEqual(rr, bytes);
		assert.equal((await call(p, "GET", `/api/sessions/img-cold/images/${"0".repeat(64)}`, GOOD)).status, 404);
	});
});

test("the first image of a session larger than the store budget is still served", async () => {
	const imgs = [pngOf(1), pngOf(2), pngOf(3)]; // 41-43 bytes each
	writeFileSync(join(sessions, "--work--", "2026-10-07T00-00-00-000Z_img-big.jsonl"), jsonl("img-big", imgs.map(resultOf)));
	await withServer(new ImageStore({ maxBytes: 100 }), async (p) => {
		const refs = (await call(p, "GET", "/api/sessions/img-big/history", GOOD)).body.messages.map((m: any) => m.content[0].ref);
		for (let i = 0; i < 2; i++) {
			const bytes = await new Promise<Buffer>((res, rej) => httpGet({ host: "127.0.0.1", port: p, path: `/api/sessions/img-big/images/${refs[0]}`, headers: GOOD }, (x) => { const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(Buffer.concat(c))); }).on("error", rej));
			assert.deepEqual(bytes, imgs[0]);
		}
	});
});

test("images of a forked session load under its new id", async () => {
	const h = await liveWithImage("img-fork-a");
	const sse = await openSse(port, "/api/sessions/img-fork-a/stream", GOOD);
	await sse.next((m) => m.type === "snapshot");
	h.sessionId = "img-fork-b";
	h.push({ type: "snapshot", snapshot: h.snapshot() });
	const snap: any = await sse.next((m) => m.type === "snapshot");
	const ref = snap.snapshot.conv.messages[0].content[0].ref;
	const r = await getBytes(`/api/sessions/img-fork-b/images/${ref}`, GOOD);
	assert.equal(r.status, 200);
	assert.deepEqual(r.body, PNG);
	sse.close();
});

test("the image route refuses requests without an allowed Origin", async () => {
	const path = `/api/sessions/disk-1/images/${"a".repeat(64)}`;
	assert.equal((await call(port, "GET", path, { ...GOOD, origin: "https://evil.example" })).status, 403);
	assert.equal((await call(port, "GET", path, { ...GOOD, "tailscale-user-login": undefined })).status, 403);
});

test("a command result carrying an image comes back as a ref, not base64", async () => {
	const h = await liveWithImage("img-cmd");
	h.commandResult = { ok: true, data: { messages: [imgResult()] } };
	const r = await call(port, "POST", "/api/sessions/img-cmd/commands", GOOD, { type: "attach" });
	assert.equal(r.status, 200);
	assert.match(r.body.result.data.messages[0].content[0].ref, /^[0-9a-f]{64}$/);
	assert.ok(!JSON.stringify(r.body).includes(PNG_B64));
	// the handle's own result keeps its data
	assert.equal((h.commandResult.data as any).messages[0].content[0].data, PNG_B64);
});
