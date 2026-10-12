// Push notifications on this device (spec §5.5): subscribe through the service
// worker with the hub's VAPID key, register the subscription with the hub, and
// keep the two in step when the hub forgets it or changes keys.

import type { HealthInfo, PushSubscriptionInfo } from "../../../shared/src/protocol.ts";
import { hrefFor } from "./route.ts";

export type PushStatus = "unsupported" | "install-first" | "denied" | "off" | "on";

export const PUSH_COPY = {
	hint: "Get a notification when a run finishes, needs you, or hits an error.",
	noHub: "Connect to a hub first.",
	unsupported: "This browser can't receive push notifications.",
	installFirst: "On iPhone or iPad, add pi-web to the Home Screen first, then turn notifications on from there.",
	denied: "Notifications are blocked for this site. Allow them in the browser's settings.",
	noKey: "The hub has no push key. Update and restart the hub.",
} as const;

export interface PushSubLike {
	endpoint: string;
	options?: { applicationServerKey?: ArrayBuffer | null };
	toJSON(): { endpoint?: string; keys?: Record<string, string> };
	unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
	getSubscription(): Promise<PushSubLike | null>;
	subscribe(o: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<PushSubLike>;
}

export interface PushEnv {
	pushManager(): Promise<PushManagerLike | null>; // null: no service worker or no Push API here
	permission(): NotificationPermission | "unsupported";
	requestPermission(): Promise<NotificationPermission>;
	ios: boolean;
	standalone: boolean; // running as the installed home-screen app
}

export interface PushApi {
	health(): Promise<HealthInfo>;
	pushSubscribe(sub: PushSubscriptionInfo): Promise<{ ok: true }>;
	pushUnsubscribe(endpoint: string): Promise<{ ok: true }>;
}

export function base64UrlToBytes(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function pushStatus(env: PushEnv): Promise<PushStatus> {
	if (env.ios && !env.standalone) return "install-first";
	const pm = await env.pushManager();
	if (!pm) return "unsupported";
	if (env.permission() === "denied") return "denied";
	return (await pm.getSubscription()) ? "on" : "off";
}

export async function enablePush(api: PushApi, env: PushEnv): Promise<void> {
	// The prompt must start inside the user's gesture (WebKit, Firefox), so before any await.
	// Already granted (a resync, or a repeat enable) never asks.
	const perm = env.permission() === "granted" ? Promise.resolve<NotificationPermission>("granted") : env.requestPermission();
	perm.catch(() => {}); // an earlier throw below must not leave this unhandled
	const pm = await env.pushManager();
	if (!pm) throw new Error(PUSH_COPY.unsupported);
	const { vapidPublicKey } = await api.health();
	if (!vapidPublicKey) throw new Error(PUSH_COPY.noKey);
	if ((await perm) !== "granted") throw new Error(PUSH_COPY.denied);
	const key = base64UrlToBytes(vapidPublicKey);
	const sub = (await current(pm, key)) ?? (await pm.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
	await api.pushSubscribe(toInfo(sub));
}

export async function disablePush(api: PushApi, env: PushEnv): Promise<void> {
	const sub = await (await env.pushManager())?.getSubscription();
	if (!sub) return;
	// Unsubscribing locally is what matters: if the hub misses this, its next push gets a 410 and drops it.
	await api.pushUnsubscribe(sub.endpoint).catch(() => {});
	await sub.unsubscribe();
}

// On every connect: if this device has notifications on, make sure the hub has it,
// re-subscribing quietly (permission is already granted) when the hub's key changed.
export async function resyncPush(api: PushApi, env: PushEnv): Promise<void> {
	try {
		if ((await pushStatus(env)) === "on") await enablePush(api, env);
	} catch {}
}

export function openHashFromMessage(data: unknown): string | null {
	const d = data as { type?: unknown; sessionId?: unknown } | null;
	if (d?.type !== "pi-open" || typeof d.sessionId !== "string" || !d.sessionId) return null;
	return hrefFor({ name: "session", id: d.sessionId });
}

export function browserPushEnv(): PushEnv {
	const nav = navigator as Navigator & { standalone?: boolean };
	return {
		async pushManager() {
			if (!("serviceWorker" in nav) || !("PushManager" in globalThis)) return null;
			const reg = await nav.serviceWorker.getRegistration(); // none in dev, where the worker isn't registered
			return reg ? (reg.pushManager as unknown as PushManagerLike) : null;
		},
		permission: () => ("Notification" in globalThis ? Notification.permission : "unsupported"),
		requestPermission: () => Notification.requestPermission(),
		ios: /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1),
		standalone: matchMedia("(display-mode: standalone)").matches || nav.standalone === true,
	};
}

// The subscription already here, if it was made with this key. One made with another key
// (the hub regenerated its keys) can't be delivered to, so it is dropped.
async function current(pm: PushManagerLike, key: Uint8Array): Promise<PushSubLike | null> {
	const sub = await pm.getSubscription();
	if (!sub) return null;
	const have = sub.options?.applicationServerKey;
	if (have && sameBytes(new Uint8Array(have), key)) return sub;
	await sub.unsubscribe();
	return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

function toInfo(sub: PushSubLike): PushSubscriptionInfo {
	const keys = sub.toJSON().keys ?? {};
	return { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh ?? "", auth: keys.auth ?? "" } };
}
