import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Progress-panel fixtures (real pi captures, see shared/test/fixtures/progress/NOTES.md) as sessions on disk.
// Their /FIXTURE paths point at the throwaway work folder, agent dir and sessions dir.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "test", "fixtures", "progress");
const seedDir = join(pi.agentDir, "sessions", "--pi-web-e2e-progress--");
mkdirSync(seedDir, { recursive: true });
for (const name of ["todo", "subagent-fg"]) {
	const text = readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
		.replaceAll("/FIXTURE/sessions", join(pi.agentDir, "sessions"))
		.replaceAll("/FIXTURE/agent", pi.agentDir)
		.replace(/\/FIXTURE\/work-(todo|fg|x)/g, WORKDIR)
		.replaceAll("/FIXTURE", WORKDIR);
	writeFileSync(join(seedDir, `${name}.jsonl`), text);
}
// A plan with two tasks, and a session that has written it.
mkdirSync(join(WORKDIR, "docs", "superpowers", "plans"), { recursive: true });
writeFileSync(join(WORKDIR, "docs", "superpowers", "plans", "p.md"), "# Plan P\n\n### Task 1: First\n\n- [x] **Step 1: one**\n- [ ] **Step 2: two**\n\n### Task 2: Second\n\n- [ ] **Step 1: three**\n");
const at = "2026-11-08T22:20:00.000Z";
writeFileSync(
	join(seedDir, "plan.jsonl"),
	[
		{ type: "session", version: 3, id: "e2e-plan-session", timestamp: at, cwd: WORKDIR },
		{ type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "write the plan" }], timestamp: 1 } },
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: at,
			message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "write", arguments: { path: "docs/superpowers/plans/p.md", content: "x" } }], timestamp: 2 },
		},
		{ type: "message", id: "r1", parentId: "a1", timestamp: at, message: { role: "toolResult", toolCallId: "tc1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 } },
	]
		.map((e) => JSON.stringify(e))
		.join("\n") + "\n",
);

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
