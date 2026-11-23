import assert from "node:assert/strict";
import { test } from "node:test";
import piWebBridge from "../index.ts";
import type { PreviewManager } from "../preview.ts";

function setup(env: NodeJS.ProcessEnv, inject = true) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(e: any, c: any) => unknown>>();
	const pi = {
		registerTool: (t: any) => tools.set(t.name, t),
		on: (n: string, h: any) => void (handlers.get(n) ?? handlers.set(n, []).get(n)!).push(h),
	};
	const calls: string[] = [];
	const manager = {
		run: async (params: unknown, cwd: string, sid: string) => {
			calls.push(JSON.stringify(["run", params, cwd, sid]));
			return { content: [{ type: "text", text: "ok" }] };
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
		sessionManager: { getSessionId: () => "sid1" },
	};
	piWebBridge(pi as any, { preview: inject ? (manager as unknown as PreviewManager) : undefined, env: { ...env, PI_WEB: "1" } });
	return { tools, handlers, calls, statuses, ctx };
}

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
