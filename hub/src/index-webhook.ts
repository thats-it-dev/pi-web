import { createHmac, timingSafeEqual } from "node:crypto";
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

export function signIndex(secret: string, timestamp: string, delivery: string, trigger: string, isTest: boolean, body: Buffer): string {
	const prefix = Buffer.from(`v1\n${timestamp}\n${delivery}\n${trigger}\n${isTest ? "1" : "0"}\n`, "utf8");
	return createHmac("sha256", Buffer.from(secret, "utf8")).update(prefix).update(body).digest("hex");
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

export type Verify = { ok: true; isTest: boolean } | { ok: false; status: 400 | 401 | 409; reason: string };

const fail = (status: 400 | 401 | 409, reason: string): Verify => ({ ok: false, status, reason });

export function verifyIndex(h: IndexHeaders, body: Buffer, secret: string, replays: ReplayCache, now: () => number = Date.now): Verify {
	if (h.version !== "1") return fail(400, "Unsupported webhook version");
	if (!h.signature || !h.timestamp || !h.delivery) return fail(401, "Missing signature");
	if (!/^-?\d+$/.test(h.timestamp)) return fail(400, "Invalid timestamp");
	if (Math.abs(now() / 1000 - Number(h.timestamp)) > 300) return fail(401, "Expired request");
	const isTest = h.test === "true";
	const want = Buffer.from(signIndex(secret, h.timestamp, h.delivery, h.trigger ?? "", isTest, body));
	const given = Buffer.from(h.signature);
	if (given.length !== want.length || !timingSafeEqual(given, want)) return fail(401, "Invalid signature");
	if (replays.seen(h.delivery)) return fail(409, "Duplicate delivery");
	return { ok: true, isTest };
}

const BODY_MAX = 25 * 1024 * 1024;
const KEEP = 200;

export interface IndexDeps {
	watch: WatchService;
	secret: string;
	dataDir: string;
	replays?: ReplayCache;
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

// Spec §10: answer what the watch is showing, else start a session in ~/pebble.
async function decide(watch: WatchService, text: string): Promise<Pick<Sidecar, "action" | "sessionId" | "requestId" | "reason">> {
	if (!text) return { action: "kept_audio" };
	const target = watch.currentTarget();
	if (!target) return { action: "new_session", sessionId: await watch.startRingSession(text) };
	const r = await watch.answer(target.requestId, { text });
	if (r.ok) return { action: "answered", requestId: target.requestId };
	return { action: "no_match", requestId: target.requestId, reason: r.reason };
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
	const v = verifyIndex(headers, body, deps.secret, deps.replays ?? new ReplayCache(), deps.now);
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
		const transcription = (text("transcription") ?? "").trim();
		const audio = parts.find((p) => p.name === "audio")?.data;
		const delivery = headers.delivery ?? "";
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
		stage = "store";
		const { signature: _omit, ...kept } = headers;
		saveSidecar(deps.dataDir, delivery, { receivedAt: (deps.now ?? Date.now)(), headers: kept, transcription, recordedAt: text("recordedAt"), client: text("client"), ...outcome });
		prune(deps.dataDir, deps.keep ?? KEEP);
	} catch (e) {
		log(`index: ${stage}: ${(e as Error).message}`);
	}
	done();
}
