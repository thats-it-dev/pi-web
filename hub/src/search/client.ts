// The hub's handle on the search worker (worker.ts), which runs a SearchService off the main
// event loop. Protocol over worker_threads messages:
//   client → worker: { id, op: "query", q, limit, exclude? } | { id, op: "stats" } | { id, op: "sweep" }
//                    | { op: "poke" } (no reply) | { op: "close" } (the worker closes the db and exits)
//   worker → client: { id, ok: true, result } | { id, ok: false, error } | { log } (a line for our log)
// The worker sweeps once on start without holding up queries. Every call rejects after timeoutMs
// (5 s), except sweep(), which can take minutes on a cold store with the real embedder.
// A worker that exits without close() is respawned after 0 s, 5 s, 30 s, then hourly (the count
// starts over once a worker has stayed up 10 min); calls in between reject "search worker closed".

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
	respawnDelaysMs?: number[]; // waits before each respawn in a row; the last repeats; default 0, 5 s, 30 s, 1 h
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
const RESPAWN_DELAYS_MS = [0, 5000, 30_000, 60 * 60_000];
const STABLE_MS = 10 * 60_000; // a worker up this long resets the respawn backoff

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class SearchClient {
	private worker!: Worker;
	private log: (m: string) => void;
	private timeoutMs: number;
	private workerData: SearchWorkerData;
	private respawnDelays: number[];
	private respawns = 0; // in a row, since the last stable worker
	private respawnTimer: NodeJS.Timeout | null = null;
	private spawnedAt = 0;
	private alive = false;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private closed = false;
	private exited!: Promise<void>;

	constructor(opts: SearchClientOptions) {
		this.log = opts.log;
		this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
		this.respawnDelays = opts.respawnDelaysMs?.length ? opts.respawnDelaysMs : RESPAWN_DELAYS_MS;
		this.workerData = { dbFile: opts.dbFile, cacheDir: opts.cacheDir, embedder: opts.embedder, sessionsDir: opts.sessionsDir, debounceMs: opts.debounceMs };
		this.spawn();
	}

	private spawn(): void {
		const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: this.workerData });
		this.worker = worker;
		this.alive = true;
		this.spawnedAt = Date.now();
		worker.on("message", (m: WorkerReply) => this.onMessage(m));
		worker.on("error", (err) => this.log(`search worker: ${err instanceof Error ? err.message : String(err)}`));
		this.exited = new Promise((resolve) => {
			worker.once("exit", (code) => {
				this.alive = false;
				this.failAll(new Error("search worker closed"));
				if (!this.closed) this.scheduleRespawn(code);
				resolve();
			});
		});
	}

	private scheduleRespawn(code: number): void {
		if (Date.now() - this.spawnedAt >= STABLE_MS) this.respawns = 0;
		const delay = this.respawnDelays[Math.min(this.respawns, this.respawnDelays.length - 1)];
		this.respawns++;
		this.log(`search worker exited (${code}); restarting in ${Math.round(delay / 1000)} s`);
		this.respawnTimer = setTimeout(() => {
			this.respawnTimer = null;
			if (!this.closed) this.spawn();
		}, delay);
		this.respawnTimer.unref();
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
		if (!this.closed && this.alive) this.worker.postMessage({ op: "poke" });
	}

	/** Tells the worker to close its db and exit; resolves when it has (or is terminated after a grace period). */
	async close(): Promise<void> {
		if (this.respawnTimer) {
			clearTimeout(this.respawnTimer);
			this.respawnTimer = null;
		}
		if (!this.closed && this.alive) {
			this.closed = true;
			this.worker.postMessage({ op: "close" });
			const grace = setTimeout(() => void this.worker.terminate(), CLOSE_GRACE_MS);
			grace.unref();
			await this.exited;
			clearTimeout(grace);
		}
		this.closed = true;
		await this.exited;
	}

	private call(msg: { op: string; [k: string]: unknown }, timeoutMs = this.timeoutMs): Promise<unknown> {
		if (this.closed || !this.alive) return Promise.reject(new Error("search worker closed"));
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
