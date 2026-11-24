import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchDb } from "../src/search/db.ts";
import { EmbedderUnavailableError, hashEmbedder, type Embedder } from "../src/search/embedder.ts";
import { SearchService } from "../src/search/service.ts";

type Msg = { role: "user" | "assistant"; text: string };

function messageLine(sessionId: string, i: number, m: Msg): string {
	const id = `${sessionId}-m${i}`;
	const parentId = i === 0 ? null : `${sessionId}-m${i - 1}`;
	const timestamp = new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
	const content = m.role === "user" ? m.text : [{ type: "text", text: m.text }];
	return JSON.stringify({ type: "message", id, parentId, timestamp, message: { role: m.role, content, timestamp: Date.parse(timestamp) } });
}

function sessionText(sessionId: string, msgs: Msg[]): string {
	const header = { type: "session", version: 3, id: sessionId, timestamp: "2026-11-01T00:00:00.000Z", cwd: "/w" };
	return [JSON.stringify(header), ...msgs.map((m, i) => messageLine(sessionId, i, m))].join("\n") + "\n";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wraps an embedder, counting calls and the texts it was given; optional delay per call. */
function counting(inner: Embedder, delayMs = 0) {
	const seen: string[] = [];
	let calls = 0;
	const embedder: Embedder = {
		name: inner.name,
		dims: inner.dims,
		async embed(texts) {
			calls++;
			seen.push(...texts);
			if (delayMs) await sleep(delayMs);
			return inner.embed(texts);
		},
	};
	return { embedder, seen, calls: () => calls };
}

interface FixtureOpts {
	debounceMs?: number;
	embedBatch?: number;
	lookupDelayMs?: number;
}

function fixture(embedder: Embedder | null = hashEmbedder(), opts: FixtureOpts = {}) {
	const dir = mkdtempSync(join(tmpdir(), "search-service-"));
	const listing: { id: string; file: string; cwd: string; name: string | null; firstPrompt: string | null; updatedAt: number; parentSession: string | null }[] = [];
	const counts = new Map<string, number>();
	const lookups = { calls: 0, inFlight: 0, peak: 0 };
	const write = (id: string, msgs: Msg[]) => {
		const file = join(dir, `${id}.jsonl`);
		writeFileSync(file, sessionText(id, msgs));
		counts.set(id, msgs.length);
		if (!listing.some((e) => e.id === id)) listing.push({ id, file, cwd: "/w", name: null, firstPrompt: null, updatedAt: Date.now(), parentSession: null });
		return file;
	};
	const append = (id: string, m: Msg) => {
		const n = counts.get(id)!;
		appendFileSync(join(dir, `${id}.jsonl`), messageLine(id, n, m) + "\n");
		counts.set(id, n + 1);
	};
	const db = new SearchDb(":memory:");
	const lookup = async () => {
		lookups.calls++;
		lookups.inFlight++;
		lookups.peak = Math.max(lookups.peak, lookups.inFlight);
		try {
			if (opts.lookupDelayMs) await sleep(opts.lookupDelayMs);
			return listing.filter((e) => existsSync(e.file));
		} finally {
			lookups.inFlight--;
		}
	};
	const service = new SearchService({
		db,
		embedder,
		lookup,
		log: () => {},
		...(opts.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
		...(opts.embedBatch !== undefined ? { embedBatch: opts.embedBatch } : {}),
	});
	// A sweep only starts the embed loop; this also waits for it (embedPending shares the running loop).
	const sweep = async () => {
		const r = await service.sweep();
		await service.embedPending();
		return r;
	};
	const done = () => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	};
	return { dir, listing, lookups, write, append, db, service, sweep, done };
}

test("sweep indexes new files, skips unchanged, re-indexes changed, purges vanished", async () => {
	const f = fixture();
	try {
		f.write("s1", [{ role: "user", text: "alpha bravo" }, { role: "assistant", text: "charlie delta" }]);
		const f2 = f.write("s2", [{ role: "user", text: "echo foxtrot" }]);
		assert.deepEqual(await f.sweep(), { indexed: 2, removed: 0 });
		assert.deepEqual(f.service.stats(), { files: 2, chunks: 3, embedded: 3, semantic: true });

		assert.deepEqual(await f.sweep(), { indexed: 0, removed: 0 });

		f.append("s1", { role: "user", text: "golf hotel" });
		assert.deepEqual(await f.sweep(), { indexed: 1, removed: 0 });
		assert.equal(f.service.stats().chunks, 4);
		assert.equal(f.service.stats().embedded, 4);
		assert.equal((await f.service.query("golf", 5)).hits[0]?.sessionId, "s1");

		unlinkSync(f2);
		assert.deepEqual(await f.sweep(), { indexed: 0, removed: 1 });
		assert.deepEqual(f.service.stats(), { files: 1, chunks: 3, embedded: 3, semantic: true });
	} finally {
		f.done();
	}
});

test("re-indexing a changed file embeds only its new chunks", async () => {
	const c = counting(hashEmbedder());
	const f = fixture(c.embedder);
	try {
		f.write("s1", [{ role: "user", text: "alpha bravo" }, { role: "assistant", text: "charlie delta" }]);
		await f.sweep();
		assert.deepEqual(c.seen, ["alpha bravo", "charlie delta"]);
		f.append("s1", { role: "user", text: "golf hotel" });
		await f.sweep();
		assert.deepEqual(c.seen, ["alpha bravo", "charlie delta", "golf hotel"]);
		assert.equal(f.service.stats().embedded, 3);
	} finally {
		f.done();
	}
});

test("sweep purges a vanished file", async () => {
	const f = fixture();
	try {
		const file = f.write("gone", [{ role: "user", text: "zanzibar itinerary" }]);
		f.write("kept", [{ role: "user", text: "something else entirely" }]);
		await f.sweep();
		assert.deepEqual((await f.service.query("zanzibar", 5)).hits.map((h) => h.sessionId)[0], "gone");
		unlinkSync(file);
		await f.sweep();
		assert.equal((await f.service.query("zanzibar", 5)).hits.some((h) => h.sessionId === "gone"), false);
		assert.equal(f.db.files().has(file), false);
	} finally {
		f.done();
	}
});

test("query: a session that stops listing is dropped even before the next sweep", async () => {
	const f = fixture();
	try {
		f.write("s1", [{ role: "user", text: "zanzibar itinerary" }]);
		await f.sweep();
		f.listing.length = 0;
		assert.deepEqual((await f.service.query("zanzibar", 5)).hits, []);
	} finally {
		f.done();
	}
});

test("query: keyword-only works before any embedding (semantic false)", async () => {
	const f = fixture(null);
	try {
		f.write("s1", [{ role: "user", text: "we restarted the hubs yesterday" }, { role: "assistant", text: "done, all good" }]);
		await f.sweep();
		assert.equal(f.service.stats().embedded, 0);
		assert.equal(f.service.stats().semantic, false);
		const r = await f.service.query("restart hub", 5);
		assert.equal(r.semantic, false);
		assert.equal(r.hits.length, 1);
		const h = r.hits[0];
		assert.equal(h.sessionId, "s1");
		assert.equal(h.ordinal, 0);
		assert.equal(h.role, "user");
		assert.equal(h.snippet, "we restarted the hubs yesterday");
		assert.deepEqual(h.terms, ["restarted", "hubs"]);
		assert.equal(h.semanticOnly, false);
		assert.ok(h.score > 0);
	} finally {
		f.done();
	}
});

test("query: embedder present but nothing embedded yet is keyword-only", async () => {
	const f = fixture(null);
	try {
		f.write("s1", [{ role: "user", text: "restart the hub" }]);
		await f.sweep();
		// a second service over the same store, with an embedder that has not run yet
		const svc = new SearchService({ db: f.db, embedder: hashEmbedder(), lookup: async () => f.listing, log: () => {} });
		const r = await svc.query("restart hub", 5);
		assert.equal(r.semantic, false);
		assert.equal(r.hits.length, 1);
	} finally {
		f.done();
	}
});

test("query: fused ranking groups per session and marks semanticOnly", async () => {
	const f = fixture();
	try {
		f.write("a", [
			{ role: "user", text: "please restart the hub" },
			{ role: "assistant", text: "I will restart the hub now" },
			{ role: "user", text: "the hub restart worked" },
		]);
		f.write("c", [{ role: "user", text: "restart everything today" }]);
		f.write("z", [{ role: "user", text: "quokka marmalade sandwiches" }]);
		await f.sweep();
		const r = await f.service.query("restart hub", 8);
		assert.equal(r.semantic, true);
		const ids = r.hits.map((h) => h.sessionId);
		assert.deepEqual(ids.slice(0, 2), ["a", "c"]); // one hit per session, best first
		assert.equal(new Set(ids).size, ids.length);
		const a = r.hits[0];
		const c = r.hits[1];
		assert.equal(a.semanticOnly, false);
		assert.equal(c.semanticOnly, true);
		assert.deepEqual(c.terms, ["restart"]);
		assert.ok(a.score > c.score);
		// a plain vector top 40 can include unrelated chunks; they rank last and are semantic-only
		const z = r.hits.find((h) => h.sessionId === "z");
		if (z) {
			assert.equal(ids.indexOf("z"), 2);
			assert.equal(z.semanticOnly, true);
		}

		assert.equal((await f.service.query("restart hub", 1)).hits.length, 1);
	} finally {
		f.done();
	}
});

test("query: punctuation and stopwords give no hits", async () => {
	const f = fixture();
	try {
		f.write("s1", [{ role: "user", text: "the hub is the thing ?? yes" }]);
		await f.sweep();
		for (const q of ["??", "the", "  ", "\"", "*", "the of and", "AND OR NOT"]) {
			const r = await f.service.query(q, 5);
			assert.deepEqual(r.hits, [], q);
		}
	} finally {
		f.done();
	}
});

test("query: exclude drops the current session", async () => {
	const f = fixture();
	try {
		f.write("cur", [{ role: "user", text: "restart the hub" }]);
		f.write("old", [{ role: "user", text: "restart the hub last week" }]);
		await f.sweep();
		assert.deepEqual(new Set((await f.service.query("restart hub", 5)).hits.map((h) => h.sessionId)), new Set(["cur", "old"]));
		assert.deepEqual((await f.service.query("restart hub", 5, "cur")).hits.map((h) => h.sessionId), ["old"]);
	} finally {
		f.done();
	}
});

test("query: an excluded long session cannot crowd out the others", async () => {
	for (const embedder of [null, hashEmbedder()]) {
		const f = fixture(embedder);
		try {
			f.write("long", Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, text: `restart hub attempt ${i}` })));
			f.write("short", [{ role: "user", text: "restart the hub once" }]);
			await f.sweep();
			const r = await f.service.query("restart hub", 5, "long");
			assert.equal(r.hits[0]?.sessionId, "short");
			assert.equal(r.hits.some((h) => h.sessionId === "long"), false);
		} finally {
			f.done();
		}
	}
});

test("concurrent sweeps do not overlap and a call during a sweep runs once more", async () => {
	const f = fixture(hashEmbedder(), { lookupDelayMs: 10 });
	try {
		f.write("s1", [{ role: "user", text: "alpha" }]);
		const first = f.sweep();
		f.write("s2", [{ role: "user", text: "bravo" }]);
		const second = f.sweep();
		const third = f.sweep();
		const [r1, r2, r3] = await Promise.all([first, second, third]);
		assert.equal(r1.indexed + r2.indexed, 2);
		assert.deepEqual(r2, r3); // the queued follow-up is shared
		assert.equal(f.lookups.calls, 2);
		assert.equal(f.lookups.peak, 1);
		assert.equal(f.service.stats().files, 2);
	} finally {
		f.done();
	}
});

test("embedPending is a no-op without an embedder", async () => {
	const f = fixture(null);
	try {
		f.write("s1", [{ role: "user", text: "alpha" }]);
		await f.sweep();
		assert.equal(await f.service.embedPending(), 0);
	} finally {
		f.done();
	}
});

test("embedPending embeds in batches and a failing embedder leaves keyword search working", async () => {
	const f = fixture(null);
	const f2 = fixture({ name: "broken", dims: 4, embed: async () => { throw new Error("no model"); } });
	try {
		f.write("s1", Array.from({ length: 5 }, (_, i) => ({ role: "user" as const, text: `word${i} alpha` })));
		await f.sweep();
		const c = counting(hashEmbedder());
		const svc = new SearchService({ db: f.db, embedder: c.embedder, lookup: async () => f.listing, log: () => {}, embedBatch: 2 });
		assert.equal(await svc.embedPending(), 5);
		assert.equal(c.calls(), 3);
		assert.equal(f.db.stats().embedded, 5);

		f2.write("s1", [{ role: "user", text: "restart the hub" }]);
		await f2.sweep();
		assert.equal(f2.service.stats().embedded, 0);
		const r = await f2.service.query("restart hub", 5);
		assert.equal(r.semantic, false);
		assert.equal(r.hits.length, 1);
	} finally {
		f.done();
		f2.done();
	}
});

test("poke re-indexes a changed file", async () => {
	const f = fixture(hashEmbedder(), { debounceMs: 200 });
	try {
		f.write("s1", [{ role: "user", text: "alpha" }]);
		await f.sweep();
		f.append("s1", { role: "assistant", text: "the walrus migration finished" });
		f.service.poke();
		f.service.poke();
		const deadline = Date.now() + 3000;
		let hits: { sessionId: string; ordinal: number }[] = [];
		while (Date.now() < deadline) {
			// keyword hits only: before the re-index, the old chunk can still come back as a semantic-only hit
			hits = (await f.service.query("walrus", 5)).hits.filter((h) => !h.semanticOnly);
			if (hits.length) break;
			await sleep(50);
		}
		assert.deepEqual(hits.map((h) => [h.sessionId, h.ordinal]), [["s1", 1]]);
		await f.sweep(); // let the poked sweep settle before the store closes
	} finally {
		f.done();
	}
});

test("two pokes run one sweep", async () => {
	const f = fixture(hashEmbedder(), { debounceMs: 50 });
	try {
		f.write("s1", [{ role: "user", text: "alpha" }]);
		f.service.poke();
		f.service.poke();
		await sleep(300);
		assert.equal(f.lookups.calls, 1);
		assert.equal(f.service.stats().files, 1);
	} finally {
		f.done();
	}
});

test("a poke during a long embedding backlog re-indexes before the backlog finishes", async () => {
	const c = counting(hashEmbedder(), 50);
	const f = fixture(c.embedder, { debounceMs: 10, embedBatch: 2 });
	try {
		f.write("backlog", Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, text: `filler message ${i}` })));
		const first = f.service.sweep(); // 15 batches × 50 ms of embedding
		await sleep(80);
		f.write("fresh", [{ role: "user", text: "the walrus has landed" }]);
		f.service.poke();
		const deadline = Date.now() + 3000;
		let found = false;
		while (Date.now() < deadline && !found) {
			found = (await f.service.query("walrus", 5)).hits.some((h) => h.sessionId === "fresh" && !h.semanticOnly);
			if (!found) await sleep(10);
		}
		assert.equal(found, true);
		assert.ok(f.db.stats().embedded < 31, `backlog already done: ${f.db.stats().embedded}`);
		await first;
		// the queued sweep picks the backlog up again and finishes it
		const end = Date.now() + 3000;
		while (Date.now() < end && f.db.stats().embedded < 31) await sleep(20);
		assert.equal(f.db.stats().embedded, 31);
		await f.sweep(); // let the poked sweep settle before the store closes
	} finally {
		f.done();
	}
});

test("a stuck query embedding answers keyword-only within the budget, and a poke re-indexes while embedding is stuck", async () => {
	const f = fixture(hashEmbedder(), { debounceMs: 10 });
	try {
		f.write("s1", [{ role: "user", text: "restart the hub" }]);
		await f.sweep(); // the store now has vectors, as after a hub restart
		let calls = 0;
		const stuck: Embedder = {
			name: "stuck",
			dims: 384,
			embed: () => {
				calls++;
				return new Promise<Float32Array[]>(() => {});
			},
		};
		const svc = new SearchService({ db: f.db, embedder: stuck, lookup: async () => f.listing.filter((e) => existsSync(e.file)), log: () => {}, debounceMs: 10 });

		const t0 = Date.now();
		const r = await svc.query("restart hub", 5);
		const took = Date.now() - t0;
		assert.ok(took >= 900 && took < 1200, `took ${took} ms`);
		assert.equal(r.semantic, false);
		assert.deepEqual(r.hits.map((h) => h.sessionId), ["s1"]);

		// a sweep finishes even though the embed loop it starts never does
		f.write("s2", [{ role: "user", text: "the walrus has landed" }]);
		assert.deepEqual(await svc.sweep(), { indexed: 1, removed: 0 });
		const before = calls;
		f.append("s2", { role: "assistant", text: "and the narwhal too" });
		svc.poke();
		const deadline = Date.now() + 5000;
		let found = false;
		while (Date.now() < deadline && !found) {
			found = (await svc.query("narwhal", 5)).hits.some((h) => h.sessionId === "s2" && h.ordinal === 1);
			if (!found) await sleep(20);
		}
		assert.equal(found, true, "the poked sweep re-indexed past the stuck embed");
		assert.ok(calls > before, "queries kept asking for an embedding");
		assert.equal(f.db.stats().embedded, 1, "nothing new was embedded");
	} finally {
		f.done();
	}
});

test("a failing embedder logs once per window; an unavailable model is left to the embedder's own log", async () => {
	const cases: [Error, number][] = [
		[new Error("onnx blew up"), 1],
		[new EmbedderUnavailableError("embedding model failed to load; will retry in 60 min"), 0],
	];
	for (const [err, want] of cases) {
		const logs: string[] = [];
		const f = fixture(null);
		try {
			const broken: Embedder = { name: "broken", dims: 4, embed: async () => { throw err; } };
			const svc = new SearchService({ db: f.db, embedder: broken, lookup: async () => f.listing, log: (m) => logs.push(m) });
			f.write("s1", [{ role: "user", text: "alpha" }]);
			for (let i = 0; i < 3; i++) {
				f.append("s1", { role: "user", text: `more ${i}` });
				await svc.sweep();
				await svc.embedPending();
			}
			assert.equal(logs.filter((l) => l.includes("embedding failed")).length, want, err.message);
		} finally {
			f.done();
		}
	}
});
