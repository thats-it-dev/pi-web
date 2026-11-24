// The hub's handle on the search worker (worker.ts), which runs a SearchService off the main
// event loop. Protocol over worker_threads messages:
//   client → worker: { id, op: "query", q, limit, exclude? } | { id, op: "stats" } | { id, op: "sweep" }
//                    | { op: "poke" } (no reply) | { op: "close" } (the worker closes the db and exits)
//   worker → client: { id, ok: true, result } | { id, ok: false, error } | { log } (a line for our log)
// The worker sweeps once on start without holding up queries. Every call rejects after timeoutMs
// (5 s), except sweep(), which can take minutes on a cold store with the real embedder.

import { Worker } from "node:worker_threads";
import type { RawHit } from "./service.ts";
import type { EmbedderKind, SearchWorkerData, WorkerReply } from "./worker.ts";

export interface SearchClientOptions {
	dbFile: string;
	cacheDir: string;
	embedder: EmbedderKind;
	sessionsDir: string;
	log: (m: string) => void;
	debounceMs?: number; // poke → sweep delay in the worker; the service's default (2 s) when unset
	timeoutMs?: number; // per call; default 5 s
}

export interface SearchStats {
	files: number;
	chunks: number;
	embedded: number;
	semantic: boolean;
}

const TIMEOUT_MS = 5000;
const SWEEP_TIMEOUT_MS = 10 * 60_000;
const CLOSE_GRACE_MS = 5000;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class SearchClient {
	private worker: Worker;
	private log: (m: string) => void;
	private timeoutMs: number;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private closed = false;
	private exited: Promise<void>;

	constructor(opts: SearchClientOptions) {
		this.log = opts.log;
		this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
		const workerData: SearchWorkerData = { dbFile: opts.dbFile, cacheDir: opts.cacheDir, embedder: opts.embedder, sessionsDir: opts.sessionsDir, debounceMs: opts.debounceMs };
		this.worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData });
		this.worker.on("message", (m: WorkerReply) => this.onMessage(m));
		this.worker.on("error", (err) => this.log(`search worker: ${err instanceof Error ? err.message : String(err)}`));
		this.exited = new Promise((resolve) => {
			this.worker.once("exit", (code) => {
				if (!this.closed) this.log(`search worker exited (${code})`);
				this.closed = true;
				this.failAll(new Error("search worker closed"));
				resolve();
			});
		});
	}

	query(q: string, limit: number, exclude?: string): Promise<{ hits: RawHit[]; semantic: boolean }> {
		return this.call({ op: "query", q, limit, exclude }) as Promise<{ hits: RawHit[]; semantic: boolean }>;
	}

	stats(): Promise<SearchStats> {
		return this.call({ op: "stats" }) as Promise<SearchStats>;
	}

	sweep(): Promise<{ indexed: number; removed: number }> {
		return this.call({ op: "sweep" }, SWEEP_TIMEOUT_MS) as Promise<{ indexed: number; removed: number }>;
	}

	/** Asks the worker to re-sweep soon (debounced there); never waits. */
	poke(): void {
		if (!this.closed) this.worker.postMessage({ op: "poke" });
	}

	/** Tells the worker to close its db and exit; resolves when it has (or is terminated after a grace period). */
	async close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			this.worker.postMessage({ op: "close" });
			const grace = setTimeout(() => void this.worker.terminate(), CLOSE_GRACE_MS);
			grace.unref();
			await this.exited;
			clearTimeout(grace);
		}
		await this.exited;
	}

	private call(msg: { op: string; [k: string]: unknown }, timeoutMs = this.timeoutMs): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("search worker closed"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`search ${msg.op} timed out after ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.worker.postMessage({ ...msg, id });
		});
	}

	private onMessage(m: WorkerReply): void {
		if ("log" in m) return this.log(m.log);
		const p = this.pending.get(m.id);
		if (!p) return; // timed out already
		this.pending.delete(m.id);
		clearTimeout(p.timer);
		if (m.ok) p.resolve(m.result);
		else p.reject(new Error(m.error));
	}

	private failAll(err: Error): void {
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}
}
