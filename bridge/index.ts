// pi-web bridge: a pi extension that mirrors a terminal pi session to the
// pi-web hub (spec §2.2) and runs the app's commands in this process.
// Load it with `pi -e <this file>`, or install the bridge/ folder as a pi package.

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { VERSION, buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "../shared/src/protocol.ts";
import { homedir } from "node:os";
import { Type } from "typebox";
import { socketPath } from "./client.ts";
import { BridgeSession, type CtxLike, type PiLike } from "./session.ts";
import { PreviewManager, STATUS_KEY, defaultDeps } from "./preview.ts";
import { registerSearchTool } from "./search-tool.ts";
import { type ShowImageParams, showImage } from "./show-image.ts";
import { FORWARDED_EVENTS } from "./wire.ts";

type PiApi = PiLike & {
	on(event: string, handler: (event: any, ctx: CtxLike) => void): unknown;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute(id: string, params: any, signal: unknown, onUpdate: unknown, ctx: CtxLike): Promise<unknown>;
	}): void;
};

export interface BridgeOptions {
	preview?: PreviewManager;
	env?: NodeJS.ProcessEnv;
}

export default function piWebBridge(pi: PiApi, opts: BridgeOptions = {}): void {
	const env = opts.env ?? process.env;
	// Lazy: loading the extension must not touch tailscale or the filesystem.
	let manager: PreviewManager | undefined = opts.preview;
	let lastCtx: CtxLike | undefined;
	// Registered before the PI_WEB check: the hub's own headless children need the tool too.
	pi.registerTool({
		name: "show_image",
		label: "Show image",
		description:
			"Display an image file from the working directory in the conversation (PNG, JPEG, GIF or WebP, up to 2 MB; downscale larger files first). Use it for screenshots and generated images; it is displayed in the conversation and you also see it unless see is false.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the image file, absolute or relative to the working directory" }),
			caption: Type.Optional(Type.String({ description: "Short caption shown with the image" })),
			see: Type.Optional(Type.Boolean({ description: "default true; false keeps the image out of your context" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return showImage(params as ShowImageParams, ctx.cwd);
		},
	});
	registerSearchTool(pi, { env });
	pi.registerTool({
		name: "preview",
		label: "Preview",
		description:
			"Show Michael a live, clickable preview in pi-web's Preview panel (and in his phone's browser). Call it with cwd after the first visual change to an app and before any PR, then ask Michael to look (one line ending in a question) and end your turn; the page live-reloads as you edit. Call it with dir or file for an HTML mockup or prototype (no arguments returns a scratch folder to write the mockup in). Tailnet only; one preview per session; it stops when the session ends.",
		parameters: Type.Object({
			cwd: Type.Optional(Type.String({ description: "A Vite app checkout (has a dev script): start its dev server and show it" })),
			dir: Type.Optional(Type.String({ description: "A folder of static files (an HTML mockup or prototype): serve it and show it" })),
			file: Type.Optional(Type.String({ description: "One HTML file: serve its folder and open that file" })),
			stop: Type.Optional(Type.Boolean({ description: "Stop this session's preview server" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (env.PI_SUBAGENT_CHILD) {
				return {
					isError: true,
					content: [{ type: "text", text: "preview is not available in a subagent worker: ask the orchestrator to open the preview." }],
				};
			}
			lastCtx = ctx;
			manager ??= new PreviewManager(defaultDeps(homedir()));
			const result = await manager.run(params, ctx.cwd, ctx.sessionManager.getSessionId());
			ctx.ui.setStatus(STATUS_KEY, manager.statusText());
			return result;
		},
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!manager) return;
		// Kill the servers first, synchronously: pi may exit before a queued stop() (which can sit
		// behind a 30 s health wait) gets to run. stop() then removes the serve entry.
		manager.killNow();
		await manager.stop();
		(ctx?.ui ? ctx : lastCtx)?.ui.setStatus(STATUS_KEY, undefined);
	});
	if (env.PI_WEB === "1") return; // the hub's own headless children are driven over RPC already
	let session: BridgeSession | null = null;
	// No sockets in the factory: some pi invocations load extensions without a session.
	pi.on("session_start", (_event, ctx) => {
		session?.stop("reload");
		session = new BridgeSession(pi, ctx, {
			socketPath: socketPath(),
			piVersion: VERSION,
			// pi 1.0.2 puts the system prompt first as a role "system" message; the app's transcript omits it.
			buildMessages: (entries, leafId) => (buildSessionContext(entries, leafId).messages as AgentMessage[]).filter((m) => m.role !== "system"),
			thinkingLevels: (model) => (model ? getSupportedThinkingLevels(model) : ["off"]) as ThinkingLevel[],
		});
		session.start();
	});
	pi.on("session_shutdown", (event) => {
		session?.stop(event.reason);
		session = null;
	});
	for (const name of FORWARDED_EVENTS) {
		pi.on(name, (event, ctx) => {
			session?.onPiEvent(event, ctx); // observe only: returning a value could change pi's behavior
		});
	}
}
