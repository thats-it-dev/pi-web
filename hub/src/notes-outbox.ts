// Notes for the ring-profile service (POST {ringProfileUrl}/notes), kept on disk until it takes
// them: <dir>/<storeName(key)>.json. add() writes the file and tries at once; a 2xx deletes it,
// anything else keeps it, and every interval (and flush()) retries every file.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

/** Resolves true when the service took the note (a 2xx). */
export type PostNote = (body: NotesBody) => Promise<boolean>;

export interface Outbox {
	/** Writes the note and tries it at once; resolves with that try's result. */
	add(key: string, body: NotesBody): Promise<boolean>;
	/** Retries every queued note. A flush called while one runs returns the one running. */
	flush(): Promise<void>;
	/** Stops the retry timer. */
	stop(): void;
}

export function createOutbox(dir: string, post: PostNote, opts: { intervalMs: number }): Outbox {
	mkdirSync(dir, { recursive: true });
	const sending = new Set<string>(); // file names with a post in flight
	let running: Promise<void> | null = null;

	async function send(file: string, body: NotesBody): Promise<boolean> {
		if (sending.has(file)) return false;
		sending.add(file);
		try {
			let ok = false;
			try {
				ok = await post(body);
			} catch {
				ok = false;
			}
			if (ok) rmSync(join(dir, file), { force: true });
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
			writeFileSync(join(dir, file), JSON.stringify(body));
			return send(file, body);
		},
		flush,
		stop: () => clearInterval(timer),
	};
}

const RETRY_MS = 60_000;
const TIMEOUT_MS = 10_000;

/** POSTs a note to `${url}/notes`, giving up after 10 s; a 2xx is true, anything else false. */
export function postNotes(url: string): PostNote {
	const target = `${url.replace(/\/+$/, "")}/notes`;
	return async (body) => {
		try {
			const r = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
			await r.body?.cancel();
			return r.ok;
		} catch {
			return false;
		}
	};
}

/** The hub's outbox in <dataDir>/index/outbox, or none when ringProfileUrl is "" (forwarding off). */
export function createNotesOutbox(ringProfileUrl: string, dataDir: string, post: PostNote = postNotes(ringProfileUrl)): Outbox | undefined {
	if (!ringProfileUrl) return undefined;
	return createOutbox(join(dataDir, "index", "outbox"), post, { intervalMs: RETRY_MS });
}
