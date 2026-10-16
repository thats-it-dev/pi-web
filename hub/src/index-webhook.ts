import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

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
