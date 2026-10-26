import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "../../hub/test/support/fake-model.ts";
import { makePiEnv } from "../../hub/test/support/pi-env.ts";

const PORT = 7898; // keep in sync with playwright.config.ts
const WORKDIR = join(tmpdir(), "pi-web-e2e-work"); // keep in sync with smoke.spec.ts

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAG0lEQVR4nGO4Y2NDEmIY1UATDSSqvzOqgSYaAMGIVBBbdodiAAAAAElFTkSuQmCC", "base64");
// Only the hub's own children (PI_WEB=1) load it from the agent dir; the terminal test loads the bridge itself.
const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bridge", "index.ts");

// Hello for everything, except a prompt with the word "show" (not pi's compaction prompt, which says "shown"): that one calls show_image on shot.png, then wraps up.
// Keyed on the request, not on the request count, which is global across tests.
const model = await startFakeModel((req) => {
	const last = req.messages[req.messages.length - 1];
	if (last?.role === "tool") return { text: "Here is the image." };
	const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
	if (last?.role === "user" && /\bshow\b/.test(text))
		return { toolCalls: [{ id: "call_show", name: "show_image", args: { path: "shot.png", caption: "A red and blue test card" } }] };
	return { thinking: "pondering", text: "Hello world" };
});
// Manual /compact needs older turns to summarize; auto-compaction stays off so only the test compacts.
const pi = makePiEnv({ modelUrl: model.url, extensions: { "bridge.ts": `import bridge from ${JSON.stringify(BRIDGE)};\nexport default (pi) => (process.env.PI_WEB === "1" ? bridge(pi) : undefined);` }, settings: { compaction: { enabled: false, keepRecentTokens: 10 } } });
rmSync(WORKDIR, { recursive: true, force: true });
mkdirSync(join(WORKDIR, "docs"), { recursive: true });
writeFileSync(join(WORKDIR, "docs", "notes.md"), "notes\n"); // for the @ mention test
writeFileSync(join(WORKDIR, "shot.png"), PNG); // for the show_image test

const dataDir = join(pi.root, "hub");
mkdirSync(dataDir);
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ port: PORT, hostname: "localhost:5173", allowedLogin: "dev@local", dev: true, piBin: pi.piBin }));

// The terminal e2e test starts its own pi against this hub; it needs the same pi config and socket.
const E2E_ENV_FILE = join(tmpdir(), "pi-web-e2e-env.json"); // keep in sync with smoke.spec.ts
writeFileSync(E2E_ENV_FILE, JSON.stringify({ piBin: pi.piBin, agentDir: pi.agentDir, socketPath: join(dataDir, "bridge.sock") }));

// New chats start in ~: make that a throwaway folder, not the real home.
const home = join(pi.root, "home");
mkdirSync(home);
Object.assign(process.env, pi.env, { PI_WEB_DATA_DIR: dataDir, HOME: home });
process.on("exit", () => pi.cleanup());
await import("../../hub/src/main.ts");
