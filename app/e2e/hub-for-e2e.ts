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
// The preview tool needs tailscale serve, so a running preview's status is faked: when the hub resumes the live
// preview session, it reports `preview` in its statuses as the bridge does while a preview server runs.
const PREVIEW_STATUS = `export default (pi) => pi.on("session_start", (_e, ctx) => { if (process.env.PI_WEB === "1" && ctx.sessionManager.getSessionId() === "e2e-preview-live") ctx.ui.setStatus("preview", "preview fret :10600"); });`;
// Manual /compact needs older turns to summarize; auto-compaction stays off so only the test compacts.
const pi = makePiEnv({ modelUrl: model.url, extensions: { "bridge.ts": `import bridge from ${JSON.stringify(BRIDGE)};\nexport default (pi) => (process.env.PI_WEB === "1" ? bridge(pi) : undefined);`, "preview-status.ts": PREVIEW_STATUS }, settings: { compaction: { enabled: false, keepRecentTokens: 10 } } });
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
// The foreground child's own transcript, at the sessionFile the parent recorded.
{
	const parent = readFileSync(join(seedDir, "subagent-fg.jsonl"), "utf8");
	const file = /"sessionFile": "([^"]+session\.jsonl)"/.exec(parent)?.[1];
	if (!file) throw new Error("subagent-fg fixture has no child sessionFile");
	mkdirSync(dirname(file), { recursive: true });
	const t = "2026-11-08T22:11:30.000Z";
	writeFileSync(
		file,
		[
			{ type: "session", version: 3, id: "e2e-child", timestamp: t, cwd: WORKDIR },
			{ type: "message", id: "c1", parentId: null, timestamp: t, message: { role: "user", content: [{ type: "text", text: "Child task: list the files here" }], timestamp: 1 } },
			{ type: "message", id: "c2", parentId: "c1", timestamp: t, message: { role: "assistant", content: [{ type: "text", text: "Child reply: done" }], timestamp: 2 } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);
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

// An extension's notice whose text has an unbreakable run (bg_bash output carries rules of box-drawing characters),
// and a thought with a long path: neither may widen the chat beyond its column.
const RULE = "─".repeat(120);
const LONG_PATH = `/home/e2e/${"deeply-nested-folder/".repeat(8)}file.ts`;
writeFileSync(
	join(seedDir, "custom.jsonl"),
	[
		{ type: "session", version: 3, id: "e2e-custom-session", timestamp: at, cwd: WORKDIR },
		{ type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "run the checks" }], timestamp: 1 } },
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: at,
			message: { role: "assistant", content: [{ type: "thinking", thinking: `Reading ${LONG_PATH} first.` }, { type: "text", text: "Running." }], timestamp: 2 },
		},
		{ type: "custom_message", id: "n1", parentId: "a1", timestamp: at, customType: "bg-bash-done", content: `bg_bash job bg-1 exited 0 after 1m 19s:\n${RULE}\nall good`, display: true },
	]
		.map((e) => JSON.stringify(e))
		.join("\n") + "\n",
);

// Sessions that opened a dev preview (and one that then stopped it). The result timestamps are fresh, so on a tablet or
// desktop the Preview tab takes the aside (a phone shows the reply's card instead). One more has a to-do list too (both
// tabs) and an hour-old preview: reopened from history, it must not take over the aside. "e2e-preview-live" is the one
// a test resumes: its pi reports the preview status (PREVIEW_STATUS above), so the header dot shows.
const previewDetails = { url: "http://localhost:5173/", label: "fret", kind: "dev", port: 10600, root: "/x" };
function previewSession(id: string, stopped: boolean, todo = false) {
	const now = todo ? Date.now() - 3_600_000 : Date.now();
	const call = (n: number, parentId: string) => ({ type: "message", id: `a${n}`, parentId, timestamp: at, message: { role: "assistant", content: [{ type: "toolCall", id: `tc${n}`, name: "preview", arguments: { cwd: "/x" } }], timestamp: now } });
	const result = (n: number, details: unknown, text: string) => ({
		type: "message",
		id: `r${n}`,
		parentId: `a${n}`,
		timestamp: at,
		message: { role: "toolResult", toolCallId: `tc${n}`, toolName: "preview", content: [{ type: "text", text }], details, isError: false, timestamp: now },
	});
	const entries: object[] = [
		{ type: "session", version: 3, id, timestamp: at, cwd: WORKDIR },
		{ type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "show me the app" }], timestamp: 1 } },
		...(todo
			? [
					{ type: "message", id: "at", parentId: "u1", timestamp: at, message: { role: "assistant", content: [{ type: "toolCall", id: "tt", name: "todo", arguments: { action: "create", subject: "Build it" } }], timestamp: now } },
					{
						type: "message",
						id: "rt",
						parentId: "at",
						timestamp: at,
						message: { role: "toolResult", toolCallId: "tt", toolName: "todo", content: [{ type: "text", text: "Created #1" }], details: { action: "create", tasks: [{ id: 1, subject: "Build it", status: "in_progress", activeForm: "building it" }], nextId: 2 }, isError: false, timestamp: now },
					},
				]
			: []),
		call(1, todo ? "rt" : "u1"),
		result(1, previewDetails, "Preview open at http://localhost:5173/ (fret, dev server on port 10600)"),
	];
	if (stopped) entries.push(call(2, "r1"), result(2, { stopped: true }, "Preview stopped"));
	writeFileSync(join(seedDir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
previewSession("e2e-preview", false);
previewSession("e2e-preview-stopped", true);
previewSession("e2e-preview-progress", false, true);
previewSession("e2e-preview-live", false);

const dataDir = join(pi.root, "hub");
mkdirSync(dataDir);
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ port: PORT, hostname: "localhost:5173", allowedLogin: "dev@local", dev: true, piBin: pi.piBin }));

// The terminal e2e test starts its own pi against this hub; it needs the same pi config and socket.
const E2E_ENV_FILE = join(tmpdir(), "pi-web-e2e-env.json"); // keep in sync with smoke.spec.ts
writeFileSync(E2E_ENV_FILE, JSON.stringify({ piBin: pi.piBin, agentDir: pi.agentDir, socketPath: join(dataDir, "bridge.sock") }));

// New chats start in ~: make that a throwaway folder, not the real home.
const home = join(pi.root, "home");
mkdirSync(home);
// A chat session (it lives in ~) and the hub's record of it: sessions not in session-types.json are code.
{
	const t = "2026-11-08T22:30:00.000Z";
	writeFileSync(
		join(seedDir, "chat.jsonl"),
		[
			{ type: "session", version: 3, id: "e2e-chat", timestamp: t, cwd: home },
			{ type: "message", id: "u1", parentId: null, timestamp: t, message: { role: "user", content: [{ type: "text", text: "chatty hello" }], timestamp: 1 } },
			{ type: "message", id: "a1", parentId: "u1", timestamp: t, message: { role: "assistant", content: [{ type: "text", text: "Hi there" }], timestamp: 2 } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);
	writeFileSync(join(dataDir, "session-types.json"), JSON.stringify({ "e2e-chat": "chat" }));
}
Object.assign(process.env, pi.env, { PI_WEB_DATA_DIR: dataDir, HOME: home });
process.on("exit", () => pi.cleanup());
await import("../../hub/src/main.ts");
