import { expect, test, vi } from "vitest";
import { PUSH_COPY, type PushEnv, type PushManagerLike, type PushSubLike, base64UrlToBytes, disablePush, enablePush, openHashFromMessage, pushStatus, resyncPush } from "./push.ts";

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const OTHER = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";

function sub(key: string, endpoint = "https://push.example/1"): PushSubLike & { unsubscribe: ReturnType<typeof vi.fn> } {
	return {
		endpoint,
		options: { applicationServerKey: base64UrlToBytes(key).buffer as ArrayBuffer },
		toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
		unsubscribe: vi.fn(async () => true),
	};
}

function env(over: Partial<PushEnv> = {}, current: PushSubLike | null = null) {
	const pm: PushManagerLike & { current: PushSubLike | null } = {
		current,
		getSubscription: vi.fn(async () => pm.current),
		subscribe: vi.fn(async (o: { applicationServerKey: Uint8Array }) => {
			pm.current = sub(btoa(String.fromCharCode(...o.applicationServerKey)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "https://push.example/new");
			return pm.current;
		}),
	};
	const e: PushEnv = {
		pushManager: async () => pm,
		permission: () => "granted",
		requestPermission: vi.fn(async () => "granted" as NotificationPermission),
		ios: false,
		standalone: false,
		...over,
	};
	return { e, pm };
}

function api(key: string | null = KEY) {
	return {
		health: vi.fn(async () => ({ ok: true as const, login: "me", hubVersion: "0.1.0", vapidPublicKey: key })),
		pushSubscribe: vi.fn(async () => ({ ok: true as const })),
		pushUnsubscribe: vi.fn(async () => ({ ok: true as const })),
	};
}

test("base64UrlToBytes decodes a VAPID key to its 65 raw bytes", () => {
	const b = base64UrlToBytes(KEY);
	expect(b.length).toBe(65);
	expect(b[0]).toBe(4);
});

test("status covers iOS outside the home screen, no support, denied, off and on", async () => {
	expect(await pushStatus(env({ ios: true, standalone: false }).e)).toBe("install-first");
	expect(await pushStatus(env({ pushManager: async () => null }).e)).toBe("unsupported");
	expect(await pushStatus(env({ permission: () => "denied" }).e)).toBe("denied");
	expect(await pushStatus(env().e)).toBe("off");
	expect(await pushStatus(env({ ios: true, standalone: true }, sub(KEY)).e)).toBe("on");
});

test("enable asks permission, subscribes with the hub's key and registers with the hub", async () => {
	const { e, pm } = env({ permission: () => "default" });
	const a = api();
	await enablePush(a, e);
	expect(e.requestPermission).toHaveBeenCalled();
	expect(pm.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(KEY) });
	expect(a.pushSubscribe).toHaveBeenCalledWith({ endpoint: "https://push.example/new", keys: { p256dh: "p", auth: "a" } });
});

test("enable reuses a subscription made with the same key, and replaces one made with another", async () => {
	const same = env({}, sub(KEY));
	await enablePush(api(), same.e);
	expect(same.pm.subscribe).not.toHaveBeenCalled();

	const old = sub(OTHER);
	const other = env({}, old);
	await enablePush(api(), other.e);
	expect(old.unsubscribe).toHaveBeenCalled();
	expect(other.pm.subscribe).toHaveBeenCalled();
});

test("enable explains what stops it", async () => {
	await expect(enablePush(api(null), env().e)).rejects.toThrow(PUSH_COPY.noKey);
	await expect(enablePush(api(), env({ permission: () => "default", requestPermission: async () => "denied" }).e)).rejects.toThrow(PUSH_COPY.denied);
	await expect(enablePush(api(), env({ pushManager: async () => null }).e)).rejects.toThrow(PUSH_COPY.unsupported);
});

test("disable tells the hub and unsubscribes, even when the hub can't be reached", async () => {
	const s = sub(KEY);
	const a = api();
	await disablePush(a, env({}, s).e);
	expect(a.pushUnsubscribe).toHaveBeenCalledWith("https://push.example/1");
	expect(s.unsubscribe).toHaveBeenCalled();

	const s2 = sub(KEY);
	const down = { ...api(), pushUnsubscribe: vi.fn(async () => Promise.reject(new Error("offline"))) };
	await disablePush(down, env({}, s2).e);
	expect(s2.unsubscribe).toHaveBeenCalled();
	await disablePush(api(), env().e); // nothing subscribed: nothing to do
});

test("resync puts this device back on the hub only when it is on, and never throws", async () => {
	const a = api();
	await resyncPush(a, env({}, sub(KEY)).e);
	expect(a.pushSubscribe).toHaveBeenCalledTimes(1);

	const off = api();
	await resyncPush(off, env().e);
	expect(off.pushSubscribe).not.toHaveBeenCalled();

	const rotated = env({}, sub(OTHER));
	await resyncPush(api(), rotated.e); // the hub has new keys: re-subscribe without asking
	expect(rotated.pm.subscribe).toHaveBeenCalled();

	await expect(resyncPush({ ...api(), health: async () => Promise.reject(new Error("down")) }, env({}, sub(KEY)).e)).resolves.toBeUndefined();
});

test("a service-worker message routes to the session", () => {
	expect(openHashFromMessage({ type: "pi-open", sessionId: "s/1" })).toBe("#/s/s%2F1");
	expect(openHashFromMessage({ type: "pi-open" })).toBeNull();
	expect(openHashFromMessage({ type: "other", sessionId: "x" })).toBeNull();
	expect(openHashFromMessage(null)).toBeNull();
});

test("permission is never requested when already granted, on enable or resync", async () => {
	const a = env({}, sub(KEY));
	await enablePush(api(), a.e);
	await resyncPush(api(), a.e);
	expect(a.e.requestPermission).not.toHaveBeenCalled();
});

test("permission is requested synchronously, inside the user's gesture", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const { e } = env({ permission: () => "default" });
	const a = { ...api(), health: vi.fn(async () => { await gate; return { ok: true as const, login: "me", hubVersion: "0.1.0", vapidPublicKey: KEY }; }) };
	const done = enablePush(a, e);
	expect(e.requestPermission).toHaveBeenCalledTimes(1); // before pushManager()/health() could resolve
	release();
	await done;
});
