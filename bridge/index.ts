// pi-web bridge: a pi extension that mirrors a terminal pi session to the
// pi-web hub (spec §2.2) and runs the app's commands in this process.
// Load it with `pi -e <this file>`, or install the bridge/ folder as a pi package.

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { VERSION, buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "../shared/src/protocol.ts";
import { Type } from "typebox";
import { socketPath } from "./client.ts";
import { BridgeSession, type CtxLike, type PiLike } from "./session.ts";
import { type ShowImageParams, showImage } from "./show-image.ts";
import { FORWARDED_EVENTS } from "./wire.ts";

type PiApi = PiLike & {
	on(event: string, handler: (event: any, ctx: CtxLike) => void): unknown;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute(id: string, params: ShowImageParams, signal: unknown, onUpdate: unknown, ctx: CtxLike): Promise<unknown>;
	}): void;
};

export default function piWebBridge(pi: PiApi): void {
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
			return showImage(params, ctx.cwd);
		},
	});
	if (process.env.PI_WEB === "1") return; // the hub's own headless children are driven over RPC already
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
