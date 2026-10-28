// Notes for the ring-profile service (POST {ringProfileUrl}/notes), kept on disk until it takes
// them: <dir>/<storeName(key)>.json. add() writes the file (via a .tmp and a rename, so a crash
// never leaves a torn .json) and tries at once; a 2xx deletes it, a permanent rejection (a 4xx
// other than 408/429) moves it to <dir>/failed/, anything else keeps it, and every interval (and
// flush()) retries every file.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeName } from "./index-store.ts";

/** The JSON body of ring-profile's POST /notes. */
export interface NotesBody {
	dedupeKey: string;
	deliveryId?: string;
	recordedAt: number; // epoch ms
	receivedAt: number; // epoch ms
	transcript: string;
	audioBase64?: string;
	webhook: "notes";
}

/** true: the service took the note (a 2xx); "rejected": it never will (a 4xx other than 408/429); false: try again. */
export type PostResult = boolean | "rejected";
export type PostNote = (body: NotesBody) => Promise<PostResult>;

export interface Outbox {
	/** Writes the note and tries it at once; resolves with that try's result. */
	add(key: string, body: NotesBody): Promise<PostResult>;
	/** Retries every queued note. A flush called while one runs returns the one running. */
	flush(): Promise<void>;
	/** Stops the retry timer. */
	stop(): void;
}

export function createOutbox(dir: string, post: PostNote, opts: { intervalMs: number; log?: (m: string) => void }): Outbox {
	mkdirSync(dir, { recursive: true });
	const log = opts.log ?? (() => {});
	const sending = new Set<string>(); // file names with a post in flight
	let running: Promise<void> | null = null;

	async function send(file: string, body: NotesBody): Promise<PostResult> {
		if (sending.has(file)) return false;
		sending.add(file);
		try {
			let ok: PostResult = false;
			try {
				ok = await post(body);
			} catch {
				ok = false;
			}
			if (ok === true) rmSync(join(dir, file), { force: true });
			else if (ok === "rejected") {
				// Retrying would be refused for ever; keep it aside for a look.
				try {
					mkdirSync(join(dir, "failed"), { recursive: true });
					renameSync(join(dir, file), join(dir, "failed", file));
					log(`notes: ${file} rejected by ring-profile; moved to outbox/failed`);
				} catch (e) {
					log(`notes: ${file} rejected by ring-profile; move failed: ${(e as Error).message}`);
				}
			}
			return ok;
		} finally {
			sending.delete(file);
		}
	}

	async function flushAll(): Promise<void> {
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
			if (sending.has(file)) continue;
			let body: NotesBody;
			try {
				body = JSON.parse(readFileSync(join(dir, file), "utf8")) as NotesBody;
			} catch {
				continue; // gone meanwhile, or unreadable: left for a look
			}
			await send(file, body);
		}
	}

	const timer = setInterval(() => void flush(), opts.intervalMs);
	timer.unref();

	function flush(): Promise<void> {
		running ??= flushAll()
			.catch(() => {})
			.finally(() => {
				running = null;
			});
		return running;
	}

	return {
		add(key, body) {
			const file = `${storeName(key)}.json`;
			const tmp = join(dir, `${file}.tmp`);
			writeFileSync(tmp, JSON.stringify(body));
			renameSync(tmp, join(dir, file));
			return send(file, body);
		},
		flush,
		stop: () => clearInterval(timer),
	};
}

const RETRY_MS = 60_000;
const TIMEOUT_MS = 10_000;

/** POSTs a note to `${url}/notes`, giving up after 10 s: a 2xx is true, a 4xx other than 408/429 "rejected", anything else false. */
export function postNotes(url: string): PostNote {
	const target = `${url.replace(/\/+$/, "")}/notes`;
	return async (body) => {
		try {
			const r = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
			await r.body?.cancel();
			if (r.ok) return true;
			return r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429 ? "rejected" : false;
		} catch {
			return false;
		}
	};
}

/** The hub's outbox in <dataDir>/index/outbox, or none when ringProfileUrl is "" (forwarding off). */
export function createNotesOutbox(ringProfileUrl: string, dataDir: string, post: PostNote = postNotes(ringProfileUrl), log?: (m: string) => void): Outbox | undefined {
	if (!ringProfileUrl) return undefined;
	return createOutbox(join(dataDir, "index", "outbox"), post, { intervalMs: RETRY_MS, log });
}
