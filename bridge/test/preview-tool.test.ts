import assert from "node:assert/strict";
import { test } from "node:test";
import piWebBridge, { PREVIEW_ENTRY, PREVIEW_REOPEN_MS, previewToReopen } from "../index.ts";
import type { PreviewManager } from "../preview.ts";

function setup(env: NodeJS.ProcessEnv, inject = true, entries: unknown[] = [], now = () => 1_000_000) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(e: any, c: any) => unknown>>();
	const appended: Array<[string, unknown]> = [];
	const pi = {
		registerTool: (t: any) => tools.set(t.name, t),
		on: (n: string, h: any) => void (handlers.get(n) ?? handlers.set(n, []).get(n)!).push(h),
		appendEntry: (type: string, data: unknown) => void appended.push([type, data]),
	};
	const calls: string[] = [];
	const manager = {
		run: async (params: { stop?: boolean }, cwd: string, sid: string) => {
			calls.push(JSON.stringify(["run", params, cwd, sid]));
			if (params.stop) return { content: [{ type: "text", text: "Preview stopped." }], details: { stopped: true } };
			return { content: [{ type: "text", text: "ok" }], details: { url: "https://h:10600", label: "x", kind: "static", port: 10600, root: "/x" } };
		},
		stop: async () => void calls.push("stop"),
		killNow: () => void calls.push("killNow"),
		statusText: () => "preview :1",
	};
	const statuses: Array<[string, string | undefined]> = [];
	const ctx = {
		cwd: "/work",
		hasUI: true,
		ui: { setStatus: (k: string, t: string | undefined) => void statuses.push([k, t]) },
		sessionManager: { getSessionId: () => "sid1", getEntries: () => entries },
	};
	piWebBridge(pi as any, { preview: inject ? (manager as unknown as PreviewManager) : undefined, env: { ...env, PI_WEB: "1" }, now });
	return { tools, handlers, calls, statuses, ctx, appended };
}
const start = (s: ReturnType<typeof setup>) => Promise.all((s.handlers.get("session_start") ?? []).map((h) => h({}, s.ctx)));
const entry = (data: unknown) => ({ type: "custom", customType: PREVIEW_ENTRY, data });

test("registers preview and forwards to the manager, then sets the status", async () => {
	const s = setup({});
	const tool = s.tools.get("preview");
	assert.ok(tool);
	await tool.execute("id", { cwd: "/app" }, undefined, undefined, s.ctx);
	assert.deepEqual(s.calls, [JSON.stringify(["run", { cwd: "/app" }, "/work", "sid1"])]);
	assert.deepEqual(s.statuses, [["preview", "preview :1"]]);
});

test("refuses in a subagent worker without touching the manager", async () => {
	const s = setup({ PI_SUBAGENT_CHILD: "1" });
	const r = await s.tools.get("preview").execute("id", {}, undefined, undefined, s.ctx);
	assert.deepEqual(r, {
		isError: true,
		content: [{ type: "text", text: "preview is not available in a subagent worker: ask the orchestrator to open the preview." }],
	});
	assert.deepEqual(s.calls, []);
	assert.deepEqual(s.statuses, []);
});

test("session_shutdown kills the servers at once, then stops the manager and clears the status", async () => {
	const s = setup({});
	await s.tools.get("preview").execute("id", {}, undefined, undefined, s.ctx);
	s.statuses.length = 0;
	s.calls.length = 0;
	for (const h of s.handlers.get("session_shutdown") ?? []) await h({ reason: "quit" }, s.ctx);
	assert.deepEqual(s.calls, ["killNow", "stop"]);
	assert.deepEqual(s.statuses, [["preview", undefined]]);
});

test("session_shutdown clears the status on the ctx it is given, else on the last tool ctx", async () => {
	const s = setup({});
	await s.tools.get("preview").execute("id", {}, undefined, undefined, s.ctx);
	s.statuses.length = 0;
	const given: Array<[string, string | undefined]> = [];
	const shutdownCtx = { ...s.ctx, ui: { setStatus: (k: string, t: string | undefined) => void given.push([k, t]) } };
	for (const h of s.handlers.get("session_shutdown") ?? []) await h({ reason: "quit" }, shutdownCtx);
	assert.deepEqual(given, [["preview", undefined]]);
	assert.deepEqual(s.statuses, []);
	for (const h of s.handlers.get("session_shutdown") ?? []) await h({ reason: "quit" }, undefined);
	assert.deepEqual(s.statuses, [["preview", undefined]]);
});

test("session_shutdown without any preview call does nothing", async () => {
	const s = setup({}, false);
	for (const h of s.handlers.get("session_shutdown") ?? []) await h({ reason: "quit" }, s.ctx);
	assert.deepEqual(s.calls, []);
});

test("an open preview is recorded in the session, a stop too", async () => {
	const s = setup({});
	const tool = s.tools.get("preview");
	await tool.execute("id", { dir: "/x" }, undefined, undefined, s.ctx);
	await tool.execute("id", { stop: true }, undefined, undefined, s.ctx);
	assert.deepEqual(s.appended, [
		[PREVIEW_ENTRY, { params: { dir: "/x" }, at: 1_000_000 }],
		[PREVIEW_ENTRY, { stopped: true }],
	]);
});

test("a resumed session reopens its last preview and sets the status; a stopped, old or absent one is left alone", async () => {
	const open = entry({ params: { cwd: "/app" }, at: 1_000_000 - 60_000 });
	const s = setup({}, true, [{ type: "message" }, open]);
	await start(s);
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(s.calls, [JSON.stringify(["run", { cwd: "/app" }, "/work", "sid1"])]);
	assert.deepEqual(s.statuses, [["preview", "preview :1"]]);
	for (const entries of [[open, entry({ stopped: true })], [entry({ params: { cwd: "/app" }, at: 1_000_000 - PREVIEW_REOPEN_MS - 1 })], []]) {
		const t = setup({}, true, entries);
		await start(t);
		assert.deepEqual(t.calls, [], JSON.stringify(entries));
	}
	const child = setup({ PI_SUBAGENT_CHILD: "1" }, true, [open]);
	await start(child);
	assert.deepEqual(child.calls, []);
	assert.deepEqual(previewToReopen([open, entry({ params: { dir: "/m" }, at: 1_000_000 })], 1_000_000), { dir: "/m" }, "the last entry wins");
});
