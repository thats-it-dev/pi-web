// pi-web bridge: a pi extension that mirrors a terminal pi session to the
// pi-web hub (spec §2.2) and runs the app's commands in this process.
// Load it with `pi -e <this file>`, or install the bridge/ folder as a pi package.

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { VERSION, buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "../shared/src/protocol.ts";
import { socketPath } from "./client.ts";
import { BridgeSession, type CtxLike, type PiLike } from "./session.ts";
import { FORWARDED_EVENTS } from "./wire.ts";

type PiApi = PiLike & { on(event: string, handler: (event: any, ctx: CtxLike) => void): unknown };

export default function piWebBridge(pi: PiApi): void {
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
