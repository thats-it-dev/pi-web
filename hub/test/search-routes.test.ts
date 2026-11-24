import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { HubConfig } from "../src/config.ts";
import { createInternalServer } from "../src/internal-server.ts";
import { QueryStore } from "../src/queries.ts";
import { Registry } from "../src/registry.ts";
import type { RawHit } from "../src/search/service.ts";
import { createHubServer, listSummaries } from "../src/server.ts";
import { SessionIndex } from "../src/sessions.ts";
import { FakeHandle } from "./support/fake-handle.ts";
import { call } from "./support/http.ts";

const root = mkdtempSync(join(tmpdir(), "pi-web-search-routes-"));
const sessions = join(root, "sessions");
const cfg: HubConfig = {
	port: 0, internalPort: 0, hostname: "hub.test:7878", allowedLogin: "me@github", allowedOrigins: ["https://pi.thatsit.app"],
	idleMinutes: 20, maxHeadless: 6, piBin: "pi", dev: false, approvalMode: "manual", push: true, ringProfileUrl: "", dataDir: root,
};
const GOOD = { origin: "https://pi.thatsit.app", host: "hub.test:7878", "tailscale-user-login": "me@github" };

function writeSession(id: string, prompt: string): void {
	const dir = join(sessions, "--w--");
	mkdirSync(dir, { recursive: true });
	const header = { type: "session", version: 3, id, timestamp: "2026-11-01T00:00:00.000Z", cwd: "/w" };
	const msg = { type: "message", id: `${id}-m0`, parentId: null, timestamp: "2026-11-01T00:00:01.000Z", message: { role: "user", content: prompt, timestamp: 1 } };
	writeFileSync(join(dir, `2026-11-01T00-00-00-000Z_${id}.jsonl`), `${JSON.stringify(header)}\n${JSON.stringify(msg)}\n`);
}
writeSession("sess-code", "fix the parser");
writeSession("sess-chat", "plan a trip");

const raw = (sessionId: string, over: Partial<RawHit> = {}): RawHit => ({ sessionId, ordinal: 0, role: "user", snippet: "the parser", terms: ["parser"], semanticOnly: false, score: 1, ...over });
const calls: { q: string; limit: number; exclude?: string }[] = [];
const search = {
	async query(q: string, limit: number, exclude?: string) {
		calls.push({ q, limit, exclude });
		return { hits: [raw("sess-chat", { role: "assistant", semanticOnly: true }), raw("vanished"), raw("sess-code")], semantic: true };
	},
};

const index = new SessionIndex(sessions);
// sess-chat is a chat: its type comes from the registry's store, not the file.
const types = { get: (id: string) => (id === "sess-chat" ? ("chat" as const) : ("code" as const)), set: () => {} };
const registry = new Registry({ factory: { startRpc: async (o) => new FakeHandle("x", o.cwd, null) }, lookup: index, maxHeadless: 6, idleMs: 60_000, types });
const hub = createHubServer({ cfg, registry, index, version: "t", home: root, log: () => {}, search });
const bare = createHubServer({ cfg, registry, index, version: "t", home: root, log: () => {} });
const store = new QueryStore({ onChange: () => {} });
const internal = createInternalServer({ store, search, listSessions: () => listSummaries(index, registry) });
const internalBare = createInternalServer({ store });
const ports: Record<string, number> = {};
const servers: Record<string, Server> = { hub, bare, internal, internalBare };

before(async () => {
	for (const [k, s] of Object.entries(servers)) {
		await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
		ports[k] = (s.address() as AddressInfo).port;
	}
});
after(() => {
	for (const s of Object.values(servers)) {
		s.closeAllConnections();
		s.close();
	}
	store.close();
	rmSync(root, { recursive: true, force: true });
});

test("GET /api/search composes hits with the listing; type comes from the registry; unlisted sessions drop", async () => {
	calls.length = 0;
	const r = await call(ports.hub, "GET", "/api/search?q=parser", GOOD);
	assert.equal(r.status, 200);
	assert.equal(r.body.semantic, true);
	assert.deepEqual(r.body.hits.map((h: { sessionId: string; type: string }) => [h.sessionId, h.type]), [["sess-chat", "chat"], ["sess-code", "code"]]);
	assert.deepEqual(r.body.hits[0], { sessionId: "sess-chat", type: "chat", name: null, firstPrompt: "plan a trip", cwd: "/w", updatedAt: r.body.hits[0].updatedAt, ordinal: 0, role: "assistant", snippet: "the parser", terms: ["parser"], semanticOnly: true });
	assert.equal(typeof r.body.hits[0].updatedAt, "number");
	assert.deepEqual(calls, [{ q: "parser", limit: 8, exclude: undefined }]);
	assert.equal(r.headers["access-control-allow-origin"], "https://pi.thatsit.app");
});

test("GET /api/search: a short query is empty without calling the search", async () => {
	calls.length = 0;
	for (const q of ["", "a", "  b  "]) {
		const r = await call(ports.hub, "GET", `/api/search?q=${encodeURIComponent(q)}`, GOOD);
		assert.equal(r.status, 200);
		assert.deepEqual(r.body, { hits: [], semantic: false });
	}
	const none = await call(ports.hub, "GET", "/api/search", GOOD);
	assert.deepEqual(none.body, { hits: [], semantic: false });
	assert.equal(calls.length, 0);
});

test("GET /api/search clamps limit to [1, 20] and ignores exclude", async () => {
	calls.length = 0;
	for (const l of ["0", "500", "abc", "5"]) await call(ports.hub, "GET", `/api/search?q=parser&limit=${l}&exclude=sess-code`, GOOD);
	assert.deepEqual(calls.map((c) => [c.limit, c.exclude]), [[1, undefined], [20, undefined], [8, undefined], [5, undefined]]);
});

test("GET /api/search without the search dep is 404", async () => {
	const r = await call(ports.bare, "GET", "/api/search?q=parser", GOOD);
	assert.equal(r.status, 404);
	assert.deepEqual(r.body, { error: "search is not available" });
});

test("GET /api/search needs the usual auth", async () => {
	const r = await call(ports.hub, "GET", "/api/search?q=parser", { ...GOOD, "tailscale-user-login": "eve@github" });
	assert.equal(r.status, 403);
});

test("internal GET /search passes exclude and composes the same hits", async () => {
	calls.length = 0;
	const res = await fetch(`http://127.0.0.1:${ports.internal}/search?q=parser&limit=3&exclude=sess-code`);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { hits: { sessionId: string; type: string }[]; semantic: boolean };
	assert.equal(body.semantic, true);
	assert.deepEqual(body.hits.map((h) => [h.sessionId, h.type]), [["sess-chat", "chat"], ["sess-code", "code"]]);
	assert.deepEqual(calls, [{ q: "parser", limit: 3, exclude: "sess-code" }]);
	const short = await (await fetch(`http://127.0.0.1:${ports.internal}/search?q=x`)).json();
	assert.deepEqual(short, { hits: [], semantic: false });
	assert.equal(calls.length, 1);
});

test("internal GET /search without the search dep is 404", async () => {
	const res = await fetch(`http://127.0.0.1:${ports.internalBare}/search?q=parser`);
	assert.equal(res.status, 404);
	assert.deepEqual(await res.json(), { error: "search is not available" });
});
