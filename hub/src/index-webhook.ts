import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./errors.ts";
import { sendJson } from "./http.ts";
import { type Sidecar, prune, saveAudio, saveSidecar } from "./index-store.ts";
import { parseMultipart } from "./multipart.ts";
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
// a retried upload doesn't act twice.
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

// Spec §5: answer the query the watch is showing, else prompt the session it
// has open, else start a session in ~/pebble. A pending query that is not on
// screen is never answered.
async function decide(watch: WatchService, text: string): Promise<Pick<Sidecar, "action" | "sessionId" | "queryId" | "reason">> {
	if (!text) return { action: "kept_audio" };
	const shown = watch.onScreen();
	if (shown?.queryId) {
		const r = await watch.answer(shown.queryId, { text });
		if (r.ok) return { action: "answered", queryId: shown.queryId };
		// The note was meant for this query, so it never becomes a prompt or a new session.
		if (r.reason === "no_match") {
			watch.notice("Didn't catch that");
			return { action: "no_match", queryId: shown.queryId, reason: r.options?.length ? `options: ${r.options.join(", ")}` : r.reason };
		}
		if (r.reason === "gone") {
			watch.notice("Already answered");
			return { action: "gone", queryId: shown.queryId };
		}
		return { action: "error", queryId: shown.queryId, reason: `unexpected answer result: ${String((r as { reason?: unknown }).reason)}` };
	}
	if (shown?.sessionId) {
		const r = await watch.prompt(shown.sessionId, text);
		if (r.ok) return { action: "prompted", sessionId: shown.sessionId };
	}
	return { action: "new_session", sessionId: await watch.startRingSession(text) };
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
		const delivery = headers.delivery ?? "";
		let transcription = (text("transcription") ?? "").trim();
		if (transcription.length > TEXT_MAX) {
			transcription = transcription.slice(0, TEXT_MAX);
			log(`index: ${delivery} transcription cut to ${TEXT_MAX} chars`);
		}
		stage = "store";
		if (audio) saveAudio(deps.dataDir, delivery, audio);
		stage = "decide";
		let outcome: Awaited<ReturnType<typeof decide>>;
		try {
			outcome = await decide(deps.watch, transcription);
		} catch (e) {
			log(`index: decide: ${(e as Error).message}`);
			outcome = { action: "error", reason: (e as Error).message };
		}
		log(`index: ${delivery} ${outcome.action}${outcome.reason ? ` (${outcome.reason})` : ""}`);
		stage = "store";
		const { signature: _omit, ...kept } = headers;
		saveSidecar(deps.dataDir, delivery, { receivedAt: (deps.now ?? Date.now)(), headers: kept, transcription, recordedAt: text("recordedAt"), client: text("client"), ...outcome });
		prune(deps.dataDir, deps.keep ?? KEEP);
	} catch (e) {
		log(`index: ${stage}: ${(e as Error).message}`);
	}
	done();
}
