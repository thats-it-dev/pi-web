import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SearchClient } from "../src/search/client.ts";

function line(sessionId: string, i: number, role: "user" | "assistant", text: string): string {
	const timestamp = new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
	const content = role === "user" ? text : [{ type: "text", text }];
	return JSON.stringify({ type: "message", id: `${sessionId}-m${i}`, parentId: i === 0 ? null : `${sessionId}-m${i - 1}`, timestamp, message: { role, content, timestamp: Date.parse(timestamp) } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a real worker: sweep, query, poke picks up appended text, close resolves", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "search-client-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessions = join(root, "sessions");
	const dir = join(sessions, "--w--");
	mkdirSync(dir, { recursive: true });
	const id = "sess-one";
	const file = join(dir, `2026-11-01T00-00-00-000Z_${id}.jsonl`);
	const header = { type: "session", version: 3, id, timestamp: "2026-11-01T00:00:00.000Z", cwd: "/w" };
	writeFileSync(file, `${JSON.stringify(header)}\n${line(id, 0, "user", "refactor the tokenizer module")}\n${line(id, 1, "assistant", "done with the tokenizer")}\n`);

	const logs: string[] = [];
	const dbFile = join(root, "data", "search.db");
	const client = new SearchClient({ dbFile, cacheDir: join(root, "data", "models"), embedder: "hash", sessionsDir: sessions, log: (m) => logs.push(m), debounceMs: 20 });
	let closed = false;
	t.after(async () => {
		if (!closed) await client.close();
	});

	await client.sweep();
	assert.ok(existsSync(dbFile), "the worker opened the db under a created parent");
	const first = await client.query("tokenizer", 5);
	assert.equal(first.hits.length, 1);
	assert.equal(first.hits[0].sessionId, id);
	assert.equal(first.semantic, true, "the hash embedder makes vectors");
	assert.deepEqual(await client.query("tokenizer", 5, id), { hits: [], semantic: true }, "exclude reaches the service");
	const keywordHits = async (q: string) => (await client.query(q, 5)).hits.filter((h) => !h.semanticOnly);
	assert.deepEqual(await keywordHits("zeppelin"), [], "no keyword hit before the append");
	const stats = await client.stats();
	assert.equal(stats.files, 1);
	assert.ok(stats.chunks >= 1);

	appendFileSync(file, `${line(id, 2, "user", "now the zeppelin parser")}\n`);
	client.poke();
	let found = false;
	for (let i = 0; i < 100 && !found; i++) {
		await sleep(20);
		found = (await keywordHits("zeppelin")).length === 1;
	}
	assert.ok(found, "poke re-indexed the appended message");

	await client.close();
	closed = true;
	await assert.rejects(client.query("tokenizer", 5), /closed/);
});

test("an unknown op is an error reply; embedder none answers without semantic", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "search-client-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const client = new SearchClient({ dbFile: join(root, "search.db"), cacheDir: join(root, "models"), embedder: "none", sessionsDir: join(root, "none"), log: () => {} });
	t.after(() => client.close());
	await assert.rejects((client as unknown as { call(m: object): Promise<unknown> }).call({ op: "hang" }), /unknown op/);
	assert.deepEqual(await client.query("anything here", 5), { hits: [], semantic: false });
});

test("a garbage search.db is moved aside and the worker comes up on a fresh one", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "search-client-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dbFile = join(root, "search.db");
	writeFileSync(dbFile, "this is not a sqlite database, just some text that is long enough to have a header ".repeat(20));
	writeFileSync(`${dbFile}-wal`, "junk wal");
	const logs: string[] = [];
	const client = new SearchClient({ dbFile, cacheDir: join(root, "models"), embedder: "none", sessionsDir: join(root, "none"), log: (m) => logs.push(m) });
	t.after(() => client.close());
	assert.deepEqual(await client.stats(), { files: 0, chunks: 0, embedded: 0, semantic: false });
	// SQLite itself discards the junk -wal when the failed handle closes, so only the main file is left to move.
	const moved = readdirSync(root).filter((f) => f.includes(".corrupt-"));
	assert.equal(moved.length, 1, moved.join(", "));
	assert.match(moved[0], /^search\.db\.corrupt-\d+$/);
	assert.ok(logs.some((l) => l.includes("starting a fresh index")), logs.join("\n"));
});

test("a worker that dies is respawned and the next call succeeds", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "search-client-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const logs: string[] = [];
	const client = new SearchClient({ dbFile: join(root, "search.db"), cacheDir: join(root, "models"), embedder: "none", sessionsDir: join(root, "none"), log: (m) => logs.push(m), respawnDelaysMs: [0, 200] });
	t.after(() => client.close());
	assert.equal((await client.stats()).files, 0);

	const kill = () => (client as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
	const statsSoon = async () => {
		for (let i = 0; i < 100; i++) {
			try {
				return await client.stats();
			} catch (err) {
				assert.match((err as Error).message, /closed/, "between workers, calls reject with the usual error");
				await sleep(20);
			}
		}
		throw new Error("no worker came back");
	};
	await kill();
	assert.equal((await statsSoon()).files, 0);
	await kill();
	await assert.rejects(client.stats(), /closed/, "the second respawn in a row waits");
	assert.equal((await statsSoon()).files, 0);
	assert.equal(logs.filter((l) => /exited \(1\); restarting in/.test(l)).length, 2, logs.join("\n"));
});

test("a call not answered within the timeout rejects", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "search-client-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	// 1 ms is shorter than the worker's boot, so the first answer cannot arrive in time.
	const client = new SearchClient({ dbFile: join(root, "search.db"), cacheDir: join(root, "models"), embedder: "none", sessionsDir: join(root, "none"), log: () => {}, timeoutMs: 1 });
	t.after(() => client.close());
	await assert.rejects(client.stats(), /timed out/);
});
