import { createHash, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { matchOption } from "./answer-match.ts";
import { HttpError } from "./errors.ts";
import { sendJson } from "./http.ts";
import { type Sidecar, prune, saveAudio, saveSidecar } from "./index-store.ts";
import { parseMultipart } from "./multipart.ts";
import type { WatchQuery } from "../../shared/src/protocol.ts";
import type { WatchService } from "./watch.ts";

export interface IndexHeaders {
	version?: string;
	trigger?: string;
	test?: string;
	signature?: string;
	timestamp?: string;
	delivery?: string;
	audioSize?: string;
}

function first(v: string | string[] | undefined): string | undefined {
	return Array.isArray(v) ? v[0] : v;
}

export function readIndexHeaders(h: IncomingHttpHeaders): IndexHeaders {
	return {
		version: first(h["x-index-webhook-version"]),
		trigger: first(h["x-index-trigger"]),
		test: first(h["x-index-test"]),
		signature: first(h["x-index-signature"]),
		timestamp: first(h["x-index-timestamp"]),
		delivery: first(h["x-index-delivery"]),
		audioSize: first(h["x-audio-size"]),
	};
}

export class ReplayCache {
	private ids = new Map<string, number>();
	private ttlMs: number;
	private now: () => number;

	constructor(ttlMs = 3_600_000, now: () => number = Date.now) {
		this.ttlMs = ttlMs;
		this.now = now;
	}

	/** Returns true if the id was recorded within the ttl; otherwise records it and returns false. */
	seen(id: string): boolean {
		const t = this.now();
		for (const [k, at] of this.ids) if (t - at >= this.ttlMs) this.ids.delete(k);
		if (this.ids.has(id)) return true;
		this.ids.set(id, t);
		return false;
	}
}

export type Verify = { ok: true; isTest: boolean } | { ok: false; status: 400 | 409; reason: string };

const fail = (status: 400 | 409, reason: string): Verify => ({ ok: false, status, reason });

// The tailnet identity (checked in server.ts) is the only authentication; the
// Index app's signing is not required (spec §9). Replays are still refused so
// a retried upload doesn't act twice: here by X-Index-Delivery, and in
// handleIndexWebhook by the content key when the app sends no delivery id.
export function verifyIndex(h: IndexHeaders, replays: ReplayCache): Verify {
	if (h.version !== "1") return fail(400, "Unsupported webhook version");
	if (h.delivery && replays.seen(h.delivery)) return fail(409, "Duplicate delivery");
	return { ok: true, isTest: h.test === "true" };
}

const BODY_MAX = 25 * 1024 * 1024;
const KEEP = 200;
const TEXT_MAX = 8_000;

export interface IndexDeps {
	watch: WatchService;
	dataDir: string;
	replays: ReplayCache;
	now?: () => number;
	log?: (m: string) => void;
	keep?: number;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			if (size > BODY_MAX) return;
			size += c.length;
			if (size > BODY_MAX) {
				chunks.length = 0;
				reject(new HttpError(413, "Request body too large"));
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

type Decision = Pick<Sidecar, "action" | "sessionId" | "queryId" | "reason">;

interface Handlers {
	miss: () => void;
	gone: () => void;
	answered?: () => void;
}

// Spec §5: answer the query the watch is showing, else prompt the session it
// has open. With the app closed (WatchService.appOpen: no stream or poll for
// its grace period), answer the oldest alerted select/confirm pi dialog that
// existed when the note was recorded. Otherwise start a session in ~/pebble.
// While the app is open, a query that is pending but not on screen is never
// answered, and a ring-profile query only ever on screen.
async function decide(watch: WatchService, text: string, recordedAt: number | null): Promise<Decision> {
	if (!text) return { action: "kept_audio" };
	const open = watch.appOpen();
	const shown = open ? watch.onScreen() : null;
	if (shown?.queryId) {
		// Within the grace (nothing connected) the watch may be closed already: alert as when closed.
		if (watch.subscriberCount() + watch.waiterCount() > 0) return answer(watch, shown.queryId, text, { miss: () => watch.notice("Didn't catch that"), gone: () => watch.notice("Already answered") });
		// Not offered to the watch any more (ended, or held for the open web app): never answer it blind.
		const q = watch.pending().queries.find((x) => x.id === shown.queryId);
		if (!q) return { action: "gone", queryId: shown.queryId };
		return answer(watch, shown.queryId, text, closedHandlers(watch, q, text));
	}
	if (shown?.sessionId) {
		const r = await watch.prompt(shown.sessionId, text);
		if (r.ok) return { action: "prompted", sessionId: shown.sessionId };
	}
	// Without a usable recordedAt nothing is known to have existed when the note was spoken.
	const head = open || recordedAt === null ? null : watch.oldestDialog(recordedAt);
	if (head) return answer(watch, head.id, text, closedHandlers(watch, head, text));
	return { action: "new_session", sessionId: await watch.startRingSession(text) };
}

// With no watch to flash on: one receipt or miss alert through the Notifier; gone is silent.
function closedHandlers(watch: WatchService, q: WatchQuery, text: string): Handlers {
	return {
		miss: () => watch.ringAlert({ kind: "miss", query: q }),
		gone: () => {},
		// Select and confirm map text through matchOption, so this is the option sent (none for free text or a ring-profile answer).
		answered: () => {
			const m = q.source === "pi" ? matchOption(text, q.options) : null;
			if (m?.kind === "match") watch.ringAlert({ kind: "answered", query: q, option: m.option });
		},
	};
}

// The note was meant for this query, so it never becomes a prompt or a new session.
async function answer(watch: WatchService, queryId: string, text: string, on: Handlers): Promise<Decision> {
	const r = await watch.answer(queryId, { text });
	if (r.ok) {
		on.answered?.();
		return { action: "answered", queryId };
	}
	if (r.reason === "no_match") {
		on.miss();
		return { action: "no_match", queryId, reason: r.options?.length ? `options: ${r.options.join(", ")}` : r.reason };
	}
	if (r.reason === "gone") {
		on.gone();
		return { action: "gone", queryId };
	}
	return { action: "error", queryId, reason: `unexpected answer result: ${String((r as { reason?: unknown }).reason)}` };
}

/**
 * A delivery key from the note itself, for uploads without X-Index-Delivery
 * (the real Index app sends none): recordedAt, the transcription and the
 * audio bytes, hashed. A retried upload of the same note has the same key and
 * is refused as a replay; two notes differ in recordedAt or audio. The files
 * and the log line use it as the delivery name ("content-" + 32 hex chars).
 * Null when the note has neither recordedAt nor audio: two such notes saying
 * the same words would be indistinguishable, so they are not de-duplicated.
 */
export function contentKey(recordedAt: string | undefined, transcription: string, audio: Buffer | undefined): string | null {
	if (!recordedAt && !audio?.length) return null;
	const h = createHash("sha256");
	h.update(`${recordedAt ?? ""}\n${transcription}\n`);
	if (audio) h.update(audio);
	return `content-${h.digest("hex").slice(0, 32)}`;
}

// The note's recording time in ms (ms since the epoch, or a date string); null when absent or unparseable.
function recordedTime(v: string | undefined): number | null {
	if (!v) return null;
	const n = Number(v);
	if (Number.isFinite(n) && n > 0) return n;
	const d = Date.parse(v);
	return Number.isFinite(d) ? d : null;
}

export async function handleIndexWebhook(req: IncomingMessage, res: ServerResponse, deps: IndexDeps): Promise<void> {
	const log = deps.log ?? (() => {});
	const done = (): void => {
		res.writeHead(200);
		res.end();
	};
	let body: Buffer;
	try {
		body = await readBody(req);
	} catch (e) {
		req.resume(); // discard the rest; the connection closes after the answer
		const status = e instanceof HttpError ? e.status : 400;
		log(`index: rejected (${(e as Error).message})`);
		res.setHeader("connection", "close");
		return sendJson(res, status, { error: (e as Error).message }, {});
	}
	const headers = readIndexHeaders(req.headers);
	const v = verifyIndex(headers, deps.replays);
	if (!v.ok) {
		log(`index: rejected (${v.reason})`);
		return sendJson(res, v.status, { error: v.reason }, {});
	}
	if (v.isTest) {
		log("index: test event ok");
		return done();
	}
	let stage = "parse";
	try {
		let parts;
		try {
			parts = parseMultipart(body, first(req.headers["content-type"]));
		} catch (e) {
			log(`index: parse: ${(e as Error).message}`);
			return done();
		}
		const text = (name: string) => parts.find((p) => p.name === name)?.data.toString("utf8");
		const audio = parts.find((p) => p.name === "audio")?.data;
		const raw = text("transcription") ?? "";
		let delivery = headers.delivery;
		if (!delivery) {
			const key = contentKey(text("recordedAt"), raw, audio);
			if (key && deps.replays.seen(key)) {
				log("index: rejected (Duplicate delivery)");
				return sendJson(res, 409, { error: "Duplicate delivery" }, {});
			}
			delivery = key ?? randomUUID();
		}
		let transcription = raw.trim();
		if (transcription.length > TEXT_MAX) {
			transcription = transcription.slice(0, TEXT_MAX);
			log(`index: ${delivery} transcription cut to ${TEXT_MAX} chars`);
		}
		stage = "store";
		if (audio) saveAudio(deps.dataDir, delivery, audio);
		stage = "decide";
		let outcome: Decision;
		try {
			outcome = await decide(deps.watch, transcription, recordedTime(text("recordedAt")));
		} catch (e) {
			log(`index: decide: ${(e as Error).message}`);
			outcome = { action: "error", reason: (e as Error).message };
		}
		log(["index:", delivery, outcome.action, outcome.queryId ?? outcome.sessionId, outcome.reason && `(${outcome.reason})`].filter(Boolean).join(" "));
		stage = "store";
		const { signature: _omit, ...kept } = headers;
		saveSidecar(deps.dataDir, delivery, { receivedAt: (deps.now ?? Date.now)(), headers: kept, transcription, recordedAt: text("recordedAt"), client: text("client"), ...outcome });
		prune(deps.dataDir, deps.keep ?? KEEP);
	} catch (e) {
		log(`index: ${stage}: ${(e as Error).message}`);
	}
	done();
}
