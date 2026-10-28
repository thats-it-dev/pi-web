import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";

// Runs public/sw.js against a fake service-worker global and returns its handlers.
function loadWorker(windows: Array<{ postMessage: (m: unknown) => void; focus: () => Promise<unknown> }> = []) {
	const handlers: Record<string, (e: any) => void> = {};
	const self = {
		addEventListener: (type: string, fn: (e: any) => void) => (handlers[type] = fn),
		registration: { showNotification: vi.fn(async (_title: string, _opts: any) => {}) },
		clients: { matchAll: vi.fn(async (_o?: unknown) => windows), openWindow: vi.fn(async (_url: string) => null), claim: vi.fn() },
		location: { origin: "https://pi.thatsit.app" },
		skipWaiting: vi.fn(),
	};
	const src = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
	new Function("self", "caches", "fetch", src)(self, {}, vi.fn());
	return { handlers, self };
}

async function dispatch(handler: (e: any) => void, event: Record<string, unknown>): Promise<void> {
	let done: Promise<unknown> = Promise.resolve();
	handler({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) });
	await done;
}

test("a push shows a notification named for the session", async () => {
	const { handlers, self } = loadWorker();
	await dispatch(handlers.push, { data: { json: () => ({ sessionId: "s-1", title: "fix the parser", kind: "needs_you" }) } });
	expect(self.registration.showNotification).toHaveBeenCalledWith("fix the parser", {
		body: "Needs you.",
		tag: "s-1",
		renotify: true,
		data: { sessionId: "s-1" },
		icon: "/icons/icon-192.png",
	});
});

test("each kind has its own text, and a bad payload still shows something", async () => {
	const { handlers, self } = loadWorker();
	const show = self.registration.showNotification;
	await dispatch(handlers.push, { data: { json: () => ({ sessionId: "a", title: "t", kind: "finished" }) } });
	await dispatch(handlers.push, { data: { json: () => ({ sessionId: "a", title: "t", kind: "error" }) } });
	await dispatch(handlers.push, { data: { json: () => ({ sessionId: "a", title: "t", kind: "toString" }) } });
	await dispatch(handlers.push, {
		data: {
			json: () => {
				throw new SyntaxError("bad");
			},
		},
	});
	await dispatch(handlers.push, { data: null });
	expect(show.mock.calls.map((c) => c[1].body)).toEqual(["Finished.", "Stopped with an error.", "Something happened.", "Something happened.", "Something happened."]);
	expect(show.mock.calls.at(-1)?.[0]).toBe("pi");
	expect(show.mock.calls.at(-1)?.[1].tag).toBe("pi-web");
});

test("tapping a notification with the app open routes that window to the session", async () => {
	const win = { postMessage: vi.fn(), focus: vi.fn(async () => win) };
	const { handlers, self } = loadWorker([win]);
	const notification = { close: vi.fn(), data: { sessionId: "s/1" } };
	await dispatch(handlers.notificationclick, { notification });
	expect(notification.close).toHaveBeenCalled();
	expect(win.postMessage).toHaveBeenCalledWith({ type: "pi-open", sessionId: "s/1" });
	expect(win.focus).toHaveBeenCalled();
	expect(self.clients.openWindow).not.toHaveBeenCalled();
});

test("tapping a notification with the app closed opens the session", async () => {
	const { handlers, self } = loadWorker([]);
	await dispatch(handlers.notificationclick, { notification: { close: vi.fn(), data: { sessionId: "s/1" } } });
	expect(self.clients.openWindow).toHaveBeenCalledWith("/#/s/s%2F1");
	await dispatch(handlers.notificationclick, { notification: { close: vi.fn(), data: null } });
	expect(self.clients.openWindow).toHaveBeenLastCalledWith("/");
});

test("sw falls back to PUSH_BODY without body, and shows body when it is a non-empty string", async () => {
	const { handlers, self } = loadWorker();
	const show = self.registration.showNotification;
	const push = (p: object) => dispatch(handlers.push, { data: { json: () => p } });
	await push({ sessionId: "a", title: "t", kind: "finished" });
	await push({ sessionId: "a", title: "t", kind: "finished", body: "" });
	await push({ sessionId: "a", title: "t", kind: "finished", body: 5 });
	await push({ sessionId: "a", title: "t", kind: "finished", body: "Fixed the parser." });
	await push({ sessionId: "", title: "ring · follow-up", kind: "query" });
	await push({ sessionId: "", title: "ring · follow-up", kind: "query", body: "Question waiting" });
	expect(show.mock.calls.map((c) => c[1].body)).toEqual(["Finished.", "Finished.", "Finished.", "Fixed the parser.", "Question waiting", "Question waiting"]);
});

test("the notification tag is the payload's tag, else the session, else pi-web", async () => {
	const { handlers, self } = loadWorker();
	const show = self.registration.showNotification;
	const push = (p: object) => dispatch(handlers.push, { data: { json: () => p } });
	await push({ sessionId: "s-1", title: "t", kind: "needs_you", tag: "dialog:s-1:d1" });
	await push({ sessionId: "s-1", title: "t", kind: "needs_you", tag: "" });
	await push({ sessionId: "", title: "t", kind: "query", tag: "rp:1" });
	await push({ sessionId: "", title: "t", kind: "query" });
	expect(show.mock.calls.map((c) => c[1].tag)).toEqual(["dialog:s-1:d1", "s-1", "rp:1", "pi-web"]);
});
