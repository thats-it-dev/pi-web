// Worker thread that owns the search store: SQLite writes, chunking and embedding stay off the
// hub's event loop. Spoken to by SearchClient (client.ts); see its header for the protocol.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { SessionIndex } from "../sessions.ts";
import { SearchDb } from "./db.ts";
import { type Embedder, hashEmbedder, transformersEmbedder } from "./embedder.ts";
import { SearchService } from "./service.ts";

export type EmbedderKind = "transformers" | "hash" | "none";

export interface SearchWorkerData {
	dbFile: string;
	cacheDir: string;
	embedder: EmbedderKind;
	sessionsDir: string;
	debounceMs?: number;
}

export type WorkerRequest =
	| { id: number; op: "query"; q: string; limit: number; exclude?: string }
	| { id: number; op: "stats" }
	| { id: number; op: "sweep" }
	| { op: "poke" }
	| { op: "close" };

export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string } | { log: string };

if (!parentPort) throw new Error("search worker must run in a worker thread");
const port = parentPort;
const data = workerData as SearchWorkerData;
const log = (m: string) => port.postMessage({ log: m } satisfies WorkerReply);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

mkdirSync(dirname(data.dbFile), { recursive: true });
mkdirSync(data.cacheDir, { recursive: true });
const db = new SearchDb(data.dbFile);
const embedder: Embedder | null = data.embedder === "transformers" ? transformersEmbedder(data.cacheDir, log) : data.embedder === "hash" ? hashEmbedder() : null;
// The worker's own index: it caches summaries by mtime+size, so the service's lookup per query and sweep is a readdir + stats.
const index = new SessionIndex(data.sessionsDir);
const service = new SearchService({ db, embedder, lookup: () => index.list(), log, debounceMs: data.debounceMs });

// Load the model now rather than on the first query: after a restart the store already has vectors,
// so a query would otherwise wait on the load (it answers keyword-only past a 1 s budget meanwhile).
if (data.embedder === "transformers" && embedder) {
	log("search: warming the embedding model");
	embedder.embed(["warm"]).catch(() => {}); // a failure is logged by the embedder and starts its retry wait
}

service.sweep().catch((err) => log(`search: initial sweep failed: ${errText(err)}`));

async function answer(msg: Exclude<WorkerRequest, { op: "poke" } | { op: "close" }>): Promise<unknown> {
	switch (msg.op) {
		case "query":
			return service.query(msg.q, msg.limit, msg.exclude);
		case "stats":
			return service.stats();
		case "sweep":
			return service.sweep();
		default:
			throw new Error(`unknown op: ${(msg as { op: unknown }).op}`);
	}
}

port.on("message", (msg: WorkerRequest) => {
	if (msg.op === "poke") return service.poke();
	if (msg.op === "close") {
		port.close();
		db.close();
		process.exit(0);
	}
	answer(msg).then(
		(result) => port.postMessage({ id: msg.id, ok: true, result } satisfies WorkerReply),
		(err) => port.postMessage({ id: msg.id, ok: false, error: errText(err) } satisfies WorkerReply),
	);
});
