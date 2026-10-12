// Web Push for the hub (spec §5.5): VAPID keys made once, the browsers that
// subscribed, and fan-out. web-push builds the encrypted request; we send it.
// Sending never throws: a dead subscription (404/410) is dropped, anything
// else is logged.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import type { PushPayload, PushSubscriptionInfo } from "../../shared/src/protocol.ts";

const TTL_SECONDS = 3600; // a notification more than an hour late isn't worth showing
const SEND_TIMEOUT_MS = 10_000;

export interface PushStoreOptions {
	dataDir: string;
	subject: string; // VAPID contact: a mailto: or https: URL
	log?: (m: string) => void;
}

interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

export function isSubscription(x: unknown): x is PushSubscriptionInfo {
	const s = x as PushSubscriptionInfo | null;
	return !!s && typeof s === "object" && typeof s.endpoint === "string" && /^https?:\/\//.test(s.endpoint) && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";
}

export class PushStore {
	readonly publicKey: string;
	private privateKey: string;
	private subject: string;
	private file: string;
	private subs: PushSubscriptionInfo[];
	private log: (m: string) => void;

	constructor(opts: PushStoreOptions) {
		this.log = opts.log ?? ((m) => console.log(m));
		this.subject = opts.subject;
		this.file = join(opts.dataDir, "push.json");
		const { keys, fresh } = loadKeys(join(opts.dataDir, "vapid.json"), this.log);
		this.publicKey = keys.publicKey;
		this.privateKey = keys.privateKey;
		// Subscriptions are bound to the key they were made with, so new keys start an empty list.
		this.subs = fresh ? [] : loadSubs(this.file, this.log);
		if (fresh) this.save();
	}

	list(): PushSubscriptionInfo[] {
		return [...this.subs];
	}

	subscribe(sub: PushSubscriptionInfo): void {
		const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
		this.subs = [...this.subs.filter((s) => s.endpoint !== sub.endpoint), clean];
		this.save();
	}

	unsubscribe(endpoint: string): void {
		const next = this.subs.filter((s) => s.endpoint !== endpoint);
		if (next.length === this.subs.length) return;
		this.subs = next;
		this.save();
	}

	async send(payload: PushPayload): Promise<void> {
		const body = JSON.stringify(payload);
		await Promise.all(this.subs.map((s) => this.sendOne(s, body)));
	}

	private async sendOne(sub: PushSubscriptionInfo, payload: string): Promise<void> {
		const where = hostOf(sub.endpoint);
		try {
			const req = webpush.generateRequestDetails(sub, payload, {
				TTL: TTL_SECONDS,
				vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey },
			});
			// fetch sets Content-Length itself.
			const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== "content-length").map(([k, v]) => [k, String(v)]));
			const res = await fetch(req.endpoint, { method: req.method, headers, body: req.body ? new Uint8Array(req.body) : undefined, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
			if (res.status === 404 || res.status === 410) {
				this.log(`push: ${where} dropped a subscription (${res.status}); removed it`);
				this.unsubscribe(sub.endpoint);
				return;
			}
			if (!res.ok) this.log(`push: ${where} answered ${res.status}`);
		} catch (err) {
			this.log(`push: sending to ${where} failed: ${(err as Error).message}`);
		}
	}

	private save(): void {
		writeAtomic(this.file, `${JSON.stringify(this.subs, null, 2)}\n`);
	}
}

function loadKeys(file: string, log: (m: string) => void): { keys: VapidKeys; fresh: boolean } {
	if (existsSync(file)) {
		try {
			const k = JSON.parse(readFileSync(file, "utf8")) as VapidKeys;
			if (typeof k?.publicKey === "string" && typeof k.privateKey === "string") return { keys: k, fresh: false };
		} catch {}
		log(`push: ${file} was unreadable; made new keys, so every device must turn notifications on again`);
	}
	const { publicKey, privateKey } = webpush.generateVAPIDKeys();
	writeAtomic(file, `${JSON.stringify({ publicKey, privateKey }, null, 2)}\n`);
	return { keys: { publicKey, privateKey }, fresh: true };
}

function loadSubs(file: string, log: (m: string) => void): PushSubscriptionInfo[] {
	if (!existsSync(file)) return [];
	try {
		const list = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (Array.isArray(list)) return list.filter(isSubscription);
	} catch {}
	log(`push: ${file} was unreadable; starting with no subscriptions`);
	return [];
}

function writeAtomic(file: string, text: string): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, file);
}

function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return "?";
	}
}
