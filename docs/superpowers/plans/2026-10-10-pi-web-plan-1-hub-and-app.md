# pi-web Plan 1: Hub and App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship milestones 0 and 1 of the spec. First, the Chrome/tailnet access spike. Then a working hub on spark and the full PWA. Together they let Michael list every pi session (from the CLI or the app), read it, continue it with streaming output, start new sessions, switch models and thinking levels, see context and token stats, use slash commands, and answer extension dialogs, styled as direction "b · instrument".

**Architecture:** A Node hub on `127.0.0.1:7878` scans `~/.pi/agent/sessions` and runs one headless `pi --mode rpc` child per active session (`RpcHandle`). A `Registry` handles start-on-demand, re-keying, idle cleanup and the concurrency cap. The hub serves REST plus SSE, guarded by Tailscale identity, Origin and Host checks. A static Vite and Lit PWA consumes it, using one conversation reducer shared with the hub. The bridge (terminal sync), push notifications and deployment are Plans 2–4. This plan leaves the `SessionHandle` seam and the `handleKind`/`capabilities` fields ready for them.

**Tech Stack:** Node ≥ 22.18, running TypeScript directly through type stripping (no build step for the hub), `node:test`. The app uses Vite 8.3.4, Lit 3.3.3, marked 18.1.0, Vitest 5.0.3, Playwright 1.64.0 and TypeScript 5.9.3. Tests drive the real `pi` 1.0.2 binary against a fake OpenAI-compatible model server.

**Spec:** `docs/superpowers/specs/2026-10-10-pi-web-design.md`. Read it before starting. Section references below (§n) point into it.

## Global Constraints

- **Node version:** Node ≥ 22.18 (spark has v26.9.0). The hub and shared code run as `.ts` files through Node's built-in type stripping. **Erasable TypeScript only:** no `enum`, no `namespace`, no constructor parameter properties (`constructor(private x)`), no decorators. Type-only imports use `import type`.
- **Imports:** every relative import includes the `.ts` extension, for example `import { x } from "./config.ts"`. The hub and app import shared code by relative path (`../../shared/src/protocol.ts`), never by package name.
- **Pinned versions:** `typescript` 5.9.3, `@types/node` 26.6.5, `vite` 8.3.4, `vitest` 5.0.3, `lit` 3.3.3, `marked` 18.1.0, `@playwright/test` 1.64.0. No other dependencies in Plan 1. The hub has **zero runtime dependencies**.
- **Lit components:** no decorators. Declare reactive properties in `static properties`, declare the fields with `declare name: Type;`, and assign defaults in the constructor. A plain class field would shadow Lit's accessors, because `useDefineForClassFields` is on.
- **Network:** the hub binds `127.0.0.1` only. Every request except an allowed-origin CORS preflight must pass `checkRequest` (§6): `Origin` in `allowedOrigins`, `Host` or `X-Forwarded-Host` equal to `hostname`, and `Tailscale-User-Login` equal to `allowedLogin`.
- **Config:** `~/.config/pi-web/config.json`, overridable with `PI_WEB_DATA_DIR`, holding `{ port: 7878, hostname, allowedLogin, allowedOrigins: ["https://pi.thatsit.dev"], idleMinutes: 20, maxHeadless: 6, piBin: "pi", dev: false }`. For Michael: `hostname` is `spark-713a.tail9274fa.ts.net:7878` and `allowedLogin` is `michaelthatsit@github`.
- **Test isolation:** tests never read or write `~/.pi/agent` or `~/.config/pi-web`. Every test that runs pi sets `PI_CODING_AGENT_DIR` to a temp directory, and tests use `PI_BIN` (default `pi`) to locate the binary.
- **RPC framing:** split on LF only. Never use `node:readline`, because JSON strings can contain U+2028 and U+2029.
- **Design tokens** (copied exactly from thatsit.dev):
  - colors: `--primary #E4002b`, `--accent #FFAA00`, `--success #00843D`
  - light: `--bg #f1f1f1`, `--text #000`, `--text-2 #555555`, `--muted #64748b`
  - dark: `--bg #171717`, `--text #fff`, `--text-2 #a1a1aa`, `--muted #94a3b8`
  - `--border #555555`; radius `0.15rem`
  - fonts: Nunito for headings and labels, Inter for body text, Work Sans for user prompts
- **Copy:** UI labels are lowercase in Nunito with letter-spacing for the brand mark and group labels. Messages are plain sentences that say what happened and what to do, for example "Can't reach the hub. Is Tailscale connected?".
- **Commits:** small and per task, and every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Huge tool output** (a `cat` of a 5 MB log): the UI must stay responsive. Tool output is truncated to 20,000 characters with a "… N more characters" note. The test is in Task 10 (`truncateOutput`).
2. **Malformed or foreign session files** (a missing header, a half-written last line, unknown entry types, stray non-session `.jsonl`): listing must skip bad lines and files, never throw, and still show every valid session. The test is in Task 3.
3. **The pi binary missing or crashing on start** (wrong `piBin`, broken extension): the command request must fail fast with a 502 and pi's stderr, and must not hang, so the session can be tried again. The test is in Task 5.
4. **The phone sleeping mid-run, then reconnecting:** the new snapshot must contain the in-flight partial message and running tools, so the reply continues without a gap. The test is in Task 7.
5. **A prompt that opens an extension dialog** (`/ask`, permission prompts): the HTTP command must return within about 3s as `pending`, even though pi's RPC response waits for the dialog, and the dialog must reach the stream. The test is in Task 5.

## Deliberate Differences From the Spec

Small refinements found while planning. The rest of the spec stands as written.
- **`AppCommand` gains `{ type: "attach" }`.** It starts pi for a session without sending anything, which the model and stats sheets need on a session that isn't running.
- **The `StreamMessage` union gains `{ type: "detached" }`.** The session stream stays open with no process and attaches itself when one starts, so the app never has to reconnect.
- **`LiveState` is `idle | running | needs_you | error`.** "Open in terminal" is expressed as `live: true` plus `handleKind: "bridge"` instead of a separate state.
- **Session discovery also honours `PI_CODING_AGENT_DIR`,** which pi uses for its sessions directory. That's how the tests isolate pi.
- **A prompt's HTTP command returns `{ ok: true, pending: true }` after about 3s** if pi hasn't acknowledged it yet. Pi holds the RPC response while an extension command waits on a dialog. Any later failure arrives on the stream as `command_error`.
- **The cached session list for offline use lives in `localStorage`, not IndexedDB.** It's one small JSON blob.
- **App tests:** pure logic (`lib/`) gets Vitest unit tests, and components get Playwright smoke tests (Task 16), instead of DOM component tests. Every behavior listed in spec §8 is covered by one of the two.

---

## File Structure

```
package.json                      npm workspaces: shared, hub, app; root scripts
tsconfig.base.json                shared compiler options (erasable TS, .ts imports)
.gitignore
README.md                         run/dev instructions (Task 16)
spike/                            Task 0 only (throwaway, deleted after)
shared/
  package.json
  tsconfig.json
  src/protocol.ts                 every wire type: Snapshot, StreamMessage, AppCommand, SessionSummary…
  src/reducer.ts                  createConversation / applyEvent / contentText
  test/reducer.test.ts
hub/
  package.json
  tsconfig.json
  src/errors.ts                   HttpError
  src/config.ts                   loadConfig / HubConfig
  src/auth.ts                     checkRequest / corsHeaders
  src/jsonl.ts                    lineSplitter (LF-only)
  src/sessions.ts                 sessionsDir / summarize / SessionIndex / readHistory / knownCwds
  src/translate.ts                AppCommand → pi RPC command
  src/handle.ts                   SessionHandle + HandleEvent interfaces
  src/rpc-handle.ts               RpcHandle: one headless pi child
  src/registry.ts                 Registry: start-on-demand, re-key, cap, idle reaping
  src/server.ts                   createHubServer: routes, CORS, SSE
  src/main.ts                     entrypoint
  test/support/fake-model.ts      scripted OpenAI-compatible streaming server
  test/support/pi-env.ts          temp PI_CODING_AGENT_DIR with fake provider + test extension
  test/support/fake-handle.ts     in-memory SessionHandle for registry/server tests
  test/support/http.ts            raw node:http request + SSE reader helpers
  test/*.test.ts
app/
  package.json
  tsconfig.json
  vite.config.ts                  dev proxy that injects identity headers; CSP plugin for builds
  playwright.config.ts
  index.html
  public/                         fonts/, icons/, manifest.webmanifest, sw.js, theme-init.js
  scripts/make-icons.mjs          writes PNG icons (no deps)
  src/main.ts
  src/styles/global.css           tokens, @font-face, page base
  src/styles/shared.ts            Lit css shared by components (buttons, links, dots)
  src/lib/settings.ts             hub URL + theme preference
  src/lib/route.ts                hash routes
  src/lib/format.ts               tokens, times, cwd, tool-arg summaries, grouping, truncation
  src/lib/markdown.ts             sanitized marked renderer (+cache)
  src/lib/slash.ts                built-ins, menu filtering, input parsing, model matching
  src/lib/api.ts                  HubApi (fetch wrapper)
  src/lib/stream.ts               EventSource with backoff
  src/lib/session-store.ts        SessionStore: snapshot + live events for one session
  src/lib/list-store.ts           ListStore: sidebar list + /api/events
  src/lib/toast.ts                toast() event helper
  src/render/messages.ts          conversation → lit templates
  src/render/sheets.ts            model / stats / dialog / fork sheet bodies
  src/components/pi-app.ts        shell, routing, layout, mobile nav
  src/components/pi-sidebar.ts
  src/components/pi-settings.ts
  src/components/pi-new-session.ts
  src/components/pi-toasts.ts
  src/components/pi-session.ts    session controller: store, stream, commands, built-ins, sheets
  src/components/pi-header.ts
  src/components/pi-messages.ts
  src/components/pi-composer.ts
  src/components/pi-sheet.ts
  src/**/*.test.ts                vitest unit tests for lib/
  e2e/hub-for-e2e.ts              fake model + temp pi env + hub on :7899
  e2e/smoke.spec.ts
```

---
### Task 0: Spike: can a public PWA reach a tailnet hub?

This is a decision gate (§9 milestone 0). The output is a written finding, and all code in this task is throwaway. **It needs Michael:** he has to open a page on his devices and deploy one static file.

**Files:**
- Create: `spike/server.mjs` and `spike/index.html` (deleted at the end of the task)
- Create: `docs/superpowers/spikes/2026-10-10-tailnet-access.md` (kept)

- [ ] **Step 1: Write the echo server**

`spike/server.mjs`:

```js
// Throwaway: echoes request headers so we can see what tailscale serve forwards.
import { createServer } from "node:http";
createServer((req, res) => {
	const origin = req.headers.origin;
	const cors = origin ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type", vary: "Origin" } : {};
	if (req.method === "OPTIONS") {
		res.writeHead(204, cors);
		return res.end();
	}
	if (req.url === "/sse") {
		res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-store" });
		let n = 0;
		const t = setInterval(() => res.write(`data: ${JSON.stringify({ n: n++ })}\n\n`), 1000);
		req.on("close", () => clearInterval(t));
		return;
	}
	res.writeHead(200, { ...cors, "content-type": "application/json" });
	res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }, null, 2));
}).listen(7899, "127.0.0.1", () => console.log("spike on 127.0.0.1:7899"));
```

- [ ] **Step 2: Write the probe page**

`spike/index.html`:

```html
<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tailnet probe</title>
<style>body{font:16px system-ui;margin:16px}pre{white-space:pre-wrap;background:#eee;padding:8px}</style>
<h1>tailnet probe</h1>
<input id="url" size="50" value="https://spark-713a.tail9274fa.ts.net:7899" />
<button id="go">probe</button>
<pre id="out"></pre>
<script>
const out = document.getElementById("out");
const log = (s) => (out.textContent += s + "\n");
document.getElementById("go").onclick = async () => {
	out.textContent = "";
	const base = document.getElementById("url").value.replace(/\/$/, "");
	try {
		const r = await fetch(base + "/echo");
		log("GET ok: " + r.status + "\n" + (await r.text()));
	} catch (e) { log("GET failed: " + e); }
	try {
		const r = await fetch(base + "/echo", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		log("POST (preflighted) ok: " + r.status);
	} catch (e) { log("POST failed: " + e); }
	const es = new EventSource(base + "/sse");
	let got = 0;
	es.onmessage = (e) => { if (++got === 3) { log("SSE ok: " + e.data); es.close(); } };
	es.onerror = () => { log("SSE error"); es.close(); };
};
</script>
```

- [ ] **Step 3: Expose the echo server on the tailnet**

Run:
```bash
node spike/server.mjs &
tailscale serve --bg --https=7899 http://127.0.0.1:7899
```
Expected: `tailscale serve status` lists `https://spark-713a.tail9274fa.ts.net:7899 (tailnet only)`.

- [ ] **Step 4: Ask Michael to deploy and probe**

Ask Michael to:
1. Deploy `spike/index.html` publicly. Netlify Drop (https://app.netlify.com/drop) or any existing Netlify site works. Then open it in **Chrome on the Mac**, **Safari on the iPhone**, and **Safari on the iPad**, with Tailscale connected on each.
2. Click **probe**, and paste back the output from each browser, including any permission prompt Chrome showed, such as "wants to access other apps and services on this device" or "local network".

- [ ] **Step 5: Record the findings**

Write `docs/superpowers/spikes/2026-10-10-tailnet-access.md` with:
- each browser's result for GET, POST and SSE
- any prompts shown
- the exact `host`, `x-forwarded-host`, `tailscale-user-login` and `origin` headers the echo showed

Then state the decision:
- **All three work, possibly after a one-time Chrome permission:** continue with this plan unchanged. Set `hostname` in config to whichever header carried the tailnet host (`checkRequest` already accepts `host` or `x-forwarded-host`).
- **Chrome or Safari blocks it with no way to allow:** **stop and tell Michael.** The fallback (§9) serves the built app from the hub at the same origin. The changes are: Task 7 gains a static-file route for `app/dist`, `allowedOrigins` becomes the hub's own origin, and the app's hub URL defaults to `location.origin`. Get Michael's approval of that change before continuing.

- [ ] **Step 6: Clean up**

Run:
```bash
tailscale serve --https=7899 off
kill %1 2>/dev/null; rm -rf spike
git add docs/superpowers/spikes
git commit -m "docs: record tailnet access spike findings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Expected: `tailscale serve status` no longer lists `:7899`.

---

### Task 1: Workspace, shared protocol, and conversation reducer

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/protocol.ts`, `shared/src/reducer.ts`
- Test: `shared/test/reducer.test.ts`

**Interfaces:**
- Produces: every type in `shared/src/protocol.ts` (listed in its code below), plus `createConversation(messages?: AgentMessage[]): Conversation`, `applyEvent(conv: Conversation, ev: PiEvent): ConversationChange` and `contentText(content: AgentMessage["content"]): string` from `shared/src/reducer.ts`.

- [ ] **Step 1: Create the workspace files**

`package.json`:

```json
{
	"name": "pi-web",
	"private": true,
	"type": "module",
	"workspaces": ["shared", "hub", "app"],
	"engines": { "node": ">=22.18" },
	"scripts": {
		"test": "npm run test -w shared && npm run test -w hub && npm run test -w app",
		"typecheck": "npm run typecheck -w shared && npm run typecheck -w hub && npm run typecheck -w app",
		"hub": "npm run start -w hub",
		"dev": "npm run dev -w app"
	}
}
```

`tsconfig.base.json`:

```json
{
	"compilerOptions": {
		"target": "ES2023",
		"lib": ["ES2023"],
		"module": "nodenext",
		"moduleResolution": "nodenext",
		"strict": true,
		"noEmit": true,
		"allowImportingTsExtensions": true,
		"verbatimModuleSyntax": true,
		"erasableSyntaxOnly": true,
		"skipLibCheck": true,
		"types": ["node"]
	}
}
```

`.gitignore`:

```
node_modules
dist
.dev-data
test-results
playwright-report
```

`shared/package.json`:

```json
{
	"name": "@pi-web/shared",
	"private": true,
	"type": "module",
	"scripts": {
		"test": "node --test test/*.test.ts",
		"typecheck": "tsc -p tsconfig.json"
	},
	"devDependencies": { "typescript": "5.9.3", "@types/node": "26.6.5" }
}
```

`shared/tsconfig.json`:

```json
{ "extends": "../tsconfig.base.json", "include": ["src", "test"] }
```

Run: `npm install`
Expected: installs typescript and @types/node, and creates `package-lock.json`.

- [ ] **Step 2: Write the protocol types**

`shared/src/protocol.ts`:

```ts
// Wire types shared by the hub and the app. Pi's own event and message shapes
// pass through untouched (PiEvent, AgentMessage); everything else is ours.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface SessionStats {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
	sessionFile?: string;
	sessionId?: string;
}

export interface SessionStateInfo {
	model: ModelInfo | null;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionName?: string;
	sessionId: string;
	sessionFile?: string;
	messageCount: number;
	pendingMessageCount: number;
	autoCompactionEnabled: boolean;
}

export interface CommandInfo {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

export type DialogMethod = "select" | "confirm" | "input" | "editor";

export interface Dialog {
	id: string;
	method: DialogMethod;
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeout?: number;
}

export type HandleKind = "rpc" | "bridge";

export interface Capabilities {
	dialogs: "here" | "terminal";
	fork: boolean;
	clone: boolean;
	newSession: boolean;
	bash: boolean;
	export: boolean;
}

export interface Widget {
	lines: string[];
	placement: "aboveEditor" | "belowEditor";
}

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; redacted?: boolean }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; argsRaw?: string }
	| { type: "image"; data: string; mimeType: string };

// Pi AgentMessage: user | assistant | toolResult | bashExecution | custom |
// compactionSummary | branchSummary (system messages are filtered out).
export interface AgentMessage {
	role: string;
	content?: string | ContentBlock[];
	timestamp?: number;
	[key: string]: unknown;
}

// Any pi session event as emitted in RPC mode (see pi docs/json.md).
export interface PiEvent {
	type: string;
	[key: string]: any;
}

export interface ToolResultPayload {
	content?: ContentBlock[];
	details?: unknown;
}

export interface ToolRun {
	name: string;
	args?: unknown;
	running: boolean;
	partialResult?: ToolResultPayload;
	result?: ToolResultPayload;
	isError?: boolean;
}

export interface Conversation {
	messages: AgentMessage[];
	partial: AgentMessage | null;
	tools: Record<string, ToolRun>;
	streaming: boolean;
	compacting: boolean;
	queue: { steering: string[]; followUp: string[] };
	retry: { attempt: number; max: number; error?: string } | null;
}

export interface Snapshot {
	sessionId: string;
	sessionFile: string | null;
	cwd: string;
	handleKind: HandleKind;
	capabilities: Capabilities;
	conv: Conversation;
	state: SessionStateInfo;
	stats: SessionStats | null;
	models: ModelInfo[];
	thinkingLevels: ThinkingLevel[];
	commands: CommandInfo[];
	dialogs: Dialog[];
	statuses: Record<string, string>;
	widgets: Record<string, Widget>;
}

export type StreamMessage =
	| { type: "snapshot"; snapshot: Snapshot }
	| { type: "detached" }
	| { type: "event"; event: PiEvent }
	| {
			type: "meta";
			state: SessionStateInfo;
			stats: SessionStats | null;
			statuses: Record<string, string>;
			widgets: Record<string, Widget>;
			thinkingLevels: ThinkingLevel[];
	  }
	| { type: "dialog"; dialog: Dialog }
	| { type: "dialog_closed"; id: string }
	| { type: "notify"; message: string; level: "info" | "warning" | "error" }
	| { type: "editor_text"; text: string }
	| { type: "command_error"; command: string; error: string }
	| { type: "handle_gone"; reason: "exit" | "closed"; stderr?: string }
	| { type: "error"; message: string };

export type PromptMode = "send" | "steer" | "followUp";

export interface ImageInput {
	data: string; // base64, no data: prefix
	mimeType: string;
}

export type AppCommand =
	| { type: "attach" } // start pi for this session if needed; otherwise a no-op
	| { type: "prompt"; text: string; images?: ImageInput[]; mode: PromptMode }
	| { type: "abort" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking"; level: ThinkingLevel }
	| { type: "compact"; instructions?: string }
	| { type: "rename"; name: string }
	| { type: "get_fork_points" }
	| { type: "fork"; entryId: string }
	| { type: "clone" }
	| { type: "new_session" }
	| { type: "bash"; command: string; excludeFromContext: boolean }
	| { type: "export" }
	| { type: "dialog_response"; id: string; value?: string; confirmed?: boolean; cancelled?: boolean }
	| { type: "clear_queue" }
	| { type: "get_last_assistant_text" };

export const APP_COMMAND_TYPES: readonly AppCommand["type"][] = [
	"attach",
	"prompt",
	"abort",
	"set_model",
	"set_thinking",
	"compact",
	"rename",
	"get_fork_points",
	"fork",
	"clone",
	"new_session",
	"bash",
	"export",
	"dialog_response",
	"clear_queue",
	"get_last_assistant_text",
];

export interface CommandResult {
	ok: boolean;
	data?: unknown;
	error?: string;
	pending?: boolean; // prompt accepted but pi has not acknowledged yet (e.g. a dialog is open)
}

export interface ForkPoint {
	entryId: string;
	text: string;
}

export type LiveState = "idle" | "running" | "needs_you" | "error";

export interface SessionSummary {
	id: string;
	cwd: string;
	name: string | null;
	firstPrompt: string | null;
	userMessages: number;
	model: string | null;
	contextTokens: number | null;
	createdAt: number;
	updatedAt: number;
	parentSession: string | null;
	live: boolean;
	handleKind: HandleKind | null;
	state: LiveState;
}

export type ListMessage =
	| { type: "session_state"; sessionId: string; live: boolean; handleKind: HandleKind | null; state: LiveState }
	| { type: "session_list_changed" };

export interface HealthInfo {
	ok: true;
	login: string;
	hubVersion: string;
	vapidPublicKey: string | null;
}
```

- [ ] **Step 3: Write the failing reducer tests**

`shared/test/reducer.test.ts`. The event sequences were recorded from pi 1.0.2 in RPC mode against a fake model. Note that pi emits `message_start`/`message_end` for system messages, and that an assistant `message_start` can already carry content:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, PiEvent } from "../src/protocol.ts";
import { applyEvent, contentText, createConversation } from "../src/reducer.ts";

const SYSTEM = { role: "system", content: "", sections: { preamble: "You are…" }, timestamp: 1 } as AgentMessage;
const USER = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 2 } as AgentMessage;
const FINAL = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "pondering", thinkingSignature: "reasoning_content" },
		{ type: "text", text: "Hello world" },
	],
	api: "openai-completions",
	provider: "fake",
	model: "fake-a",
	usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105 },
	stopReason: "stop",
	timestamp: 3,
} as AgentMessage;

const upd = (assistantMessageEvent: object): PiEvent => ({ type: "message_update", assistantMessageEvent });

const TEXT_RUN: PiEvent[] = [
	{ type: "agent_start" },
	{ type: "turn_start" },
	{ type: "message_start", message: SYSTEM },
	{ type: "message_end", message: SYSTEM },
	{ type: "message_start", message: USER },
	{ type: "message_end", message: USER },
	{ type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }], stopReason: "pending", timestamp: 3 } },
	upd({ type: "thinking_start", contentIndex: 0 }),
	upd({ type: "thinking_delta", contentIndex: 0, delta: "pondering" }),
	upd({ type: "text_start", contentIndex: 1 }),
	upd({ type: "text_delta", contentIndex: 1, delta: "Hello " }),
	upd({ type: "text_delta", contentIndex: 1, delta: "world" }),
	upd({ type: "thinking_end", contentIndex: 0, content: "pondering" }),
	upd({ type: "text_end", contentIndex: 1, content: "Hello world" }),
	{ type: "message_end", message: FINAL },
	{ type: "turn_end", message: FINAL, toolResults: [] },
	{ type: "agent_end", messages: [], willRetry: false },
	{ type: "agent_settled" },
];

test("a full run ends with exactly the user and final assistant messages", () => {
	const conv = createConversation();
	for (const ev of TEXT_RUN) applyEvent(conv, ev);
	assert.deepEqual(conv.messages, [USER, FINAL]);
	assert.equal(conv.partial, null);
	assert.equal(conv.streaming, false);
});

test("mid-stream the partial message holds the deltas so far, without duplicating prefilled content", () => {
	const conv = createConversation();
	for (const ev of TEXT_RUN.slice(0, 11)) applyEvent(conv, ev); // through "Hello "
	assert.equal(conv.streaming, true);
	assert.deepEqual(conv.partial?.content, [
		{ type: "thinking", thinking: "pondering" },
		{ type: "text", text: "Hello " },
	]);
});

test("tool calls stream into the partial, tool runs are tracked, results append", () => {
	const conv = createConversation();
	const call = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } };
	const assistant = { role: "assistant", content: [call], stopReason: "toolUse", timestamp: 4 };
	const result = { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "hi\n" }], isError: false, timestamp: 5 };
	const events: PiEvent[] = [
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant", content: [], timestamp: 4 } },
		upd({ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" }),
		upd({ type: "toolcall_delta", contentIndex: 0, delta: '{"command":' }),
	];
	for (const ev of events) applyEvent(conv, ev);
	assert.deepEqual(conv.partial?.content, [{ type: "toolCall", id: "call_1", name: "bash", arguments: {}, argsRaw: '{"command":' }]);

	applyEvent(conv, upd({ type: "toolcall_end", contentIndex: 0, toolCall: call }));
	applyEvent(conv, { type: "message_end", message: assistant });
	applyEvent(conv, { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } });
	assert.deepEqual(conv.tools.call_1, { name: "bash", args: { command: "echo hi" }, running: true });
	applyEvent(conv, { type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" }, partialResult: { content: [{ type: "text", text: "h" }] } });
	assert.equal(conv.tools.call_1.partialResult?.content?.[0]?.type, "text");
	applyEvent(conv, { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [{ type: "text", text: "hi\n" }] }, isError: false });
	assert.equal(conv.tools.call_1.running, false);
	applyEvent(conv, { type: "message_end", message: result });
	assert.deepEqual(conv.messages, [assistant, result]);
});

test("queue, compaction and retry events update their flags", () => {
	const conv = createConversation();
	applyEvent(conv, { type: "queue_update", steering: ["stop that"], followUp: [] });
	assert.deepEqual(conv.queue, { steering: ["stop that"], followUp: [] });
	applyEvent(conv, { type: "compaction_start", reason: "manual" });
	assert.equal(conv.compacting, true);
	applyEvent(conv, { type: "compaction_end", reason: "manual", aborted: false, willRetry: false });
	assert.equal(conv.compacting, false);
	applyEvent(conv, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" });
	assert.deepEqual(conv.retry, { attempt: 1, max: 3, error: "529 overloaded" });
	applyEvent(conv, { type: "auto_retry_end", success: true, attempt: 2 });
	assert.equal(conv.retry, null);
});

test("an aborted run settles with the aborted message and no partial", () => {
	const conv = createConversation();
	const aborted = { role: "assistant", content: [{ type: "text", text: "Hel" }], stopReason: "aborted", timestamp: 9 };
	applyEvent(conv, { type: "agent_start" });
	applyEvent(conv, { type: "message_start", message: { role: "assistant", content: [], timestamp: 9 } });
	applyEvent(conv, upd({ type: "text_delta", contentIndex: 0, delta: "Hel" }));
	applyEvent(conv, { type: "message_end", message: aborted });
	applyEvent(conv, { type: "agent_settled" });
	assert.deepEqual(conv.messages, [aborted]);
	assert.equal(conv.partial, null);
});

test("createConversation drops system messages; unknown events are ignored", () => {
	const conv = createConversation([SYSTEM, USER]);
	assert.deepEqual(conv.messages, [USER]);
	assert.equal(applyEvent(conv, { type: "something_new" }), null);
});

test("contentText joins text blocks and accepts plain strings", () => {
	assert.equal(contentText("plain"), "plain");
	assert.equal(contentText([{ type: "text", text: "a" }, { type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "b" }]), "a\nb");
	assert.equal(contentText(undefined), "");
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -w shared`
Expected: FAIL, with "Cannot find module … reducer.ts".

- [ ] **Step 5: Implement the reducer**

`shared/src/reducer.ts`:

```ts
// Folds pi RPC session events into a conversation view: completed messages,
// the in-flight assistant message, and live tool runs. The hub keeps one per
// session so late joiners get a snapshot; the app applies the same events live.

import type { AgentMessage, Conversation, PiEvent } from "./protocol.ts";

export type ConversationChange = "status" | "partial" | "messages" | "tools" | "queue" | null;

export function createConversation(messages: AgentMessage[] = []): Conversation {
	return {
		messages: messages.filter((m) => m.role !== "system"),
		partial: null,
		tools: {},
		streaming: false,
		compacting: false,
		queue: { steering: [], followUp: [] },
		retry: null,
	};
}

export function applyEvent(conv: Conversation, ev: PiEvent): ConversationChange {
	switch (ev.type) {
		case "agent_start":
			conv.streaming = true;
			return "status";
		case "agent_settled":
			conv.streaming = false;
			conv.partial = null;
			conv.retry = null;
			return "status";
		case "message_start":
			// Deltas rebuild every block, so start from empty even if pi prefilled content.
			if (ev.message?.role === "assistant") {
				conv.partial = { ...ev.message, content: [] };
				return "partial";
			}
			return null;
		case "message_update":
			conv.partial ??= { role: "assistant", content: [] };
			applyDelta(conv.partial, ev.assistantMessageEvent);
			if (ev.usage) conv.partial.usage = ev.usage;
			return "partial";
		case "message_end": {
			const m = ev.message as AgentMessage | undefined;
			if (!m || m.role === "system") return null;
			if (m.role === "assistant") conv.partial = null;
			conv.messages.push(m);
			return "messages";
		}
		case "tool_execution_start":
			conv.tools[ev.toolCallId] = { name: ev.toolName, args: ev.args, running: true };
			return "tools";
		case "tool_execution_update":
			conv.tools[ev.toolCallId] = { ...conv.tools[ev.toolCallId], name: ev.toolName, args: ev.args, running: true, partialResult: ev.partialResult };
			return "tools";
		case "tool_execution_end":
			conv.tools[ev.toolCallId] = { ...conv.tools[ev.toolCallId], name: ev.toolName, running: false, result: ev.result, isError: ev.isError };
			return "tools";
		case "queue_update":
			conv.queue = { steering: ev.steering ?? [], followUp: ev.followUp ?? [] };
			return "queue";
		case "compaction_start":
			conv.compacting = true;
			return "status";
		case "compaction_end":
			conv.compacting = false;
			return "status";
		case "auto_retry_start":
			conv.retry = { attempt: ev.attempt, max: ev.maxAttempts, error: ev.errorMessage };
			return "status";
		case "auto_retry_end":
			conv.retry = null;
			return "status";
		default:
			return null;
	}
}

function applyDelta(msg: AgentMessage, d: any): void {
	if (!d) return;
	if (!Array.isArray(msg.content)) msg.content = [];
	const c = msg.content as any[];
	const i = d.contentIndex;
	switch (d.type) {
		case "text_start":
			c[i] = { type: "text", text: "" };
			break;
		case "text_delta":
			c[i] ??= { type: "text", text: "" };
			c[i].text += d.delta;
			break;
		case "text_end":
			c[i] = { type: "text", text: d.content ?? c[i]?.text ?? "" };
			break;
		case "thinking_start":
			c[i] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta":
			c[i] ??= { type: "thinking", thinking: "" };
			c[i].thinking += d.delta;
			break;
		case "thinking_end":
			c[i] = { type: "thinking", thinking: d.content ?? c[i]?.thinking ?? "" };
			break;
		case "toolcall_start":
			c[i] = { type: "toolCall", id: d.id, name: d.toolName, arguments: {}, argsRaw: "" };
			break;
		case "toolcall_delta":
			c[i] ??= { type: "toolCall", id: "", name: "", arguments: {}, argsRaw: "" };
			c[i].argsRaw = (c[i].argsRaw ?? "") + d.delta;
			break;
		case "toolcall_end":
			if (d.toolCall) c[i] = d.toolCall;
			break;
	}
}

export function contentText(content: AgentMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b.type === "text")
		.map((b) => (b as { text: string }).text)
		.join("\n");
}
```

- [ ] **Step 6: Run the tests and typecheck to verify they pass**

Run: `npm test -w shared && npm run typecheck -w shared`
Expected: 7 tests pass and tsc exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json .gitignore shared
git commit -m "feat(shared): wire protocol types and conversation reducer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: Hub config and request auth

**Files:**
- Create: `hub/package.json`, `hub/tsconfig.json`, `hub/src/errors.ts`, `hub/src/config.ts`, `hub/src/auth.ts`
- Test: `hub/test/config.test.ts`, `hub/test/auth.test.ts`

**Interfaces:**
- Produces:
  - `class HttpError extends Error { status: number }`
  - `interface HubConfig { port: number; hostname: string; allowedLogin: string; allowedOrigins: string[]; idleMinutes: number; maxHeadless: number; piBin: string; dev: boolean; dataDir: string }`
  - `loadConfig(dataDir?: string): HubConfig`, which throws `ConfigError`
  - `checkRequest(cfg, headers: IncomingHttpHeaders): AuthResult`
  - `corsHeaders(cfg, origin: string | undefined): Record<string, string>`

- [ ] **Step 1: Create the hub package**

`hub/package.json`:

```json
{
	"name": "@pi-web/hub",
	"private": true,
	"type": "module",
	"version": "0.1.0",
	"scripts": {
		"start": "node src/main.ts",
		"test": "node --test --test-concurrency=1 test/*.test.ts",
		"typecheck": "tsc -p tsconfig.json"
	},
	"devDependencies": { "typescript": "5.9.3", "@types/node": "26.6.5" }
}
```

`hub/tsconfig.json`:

```json
{ "extends": "../tsconfig.base.json", "include": ["src", "test"] }
```

`hub/src/errors.ts`:

```ts
export class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}
```

Run: `npm install`
Expected: workspace linked, no errors.

- [ ] **Step 2: Write the failing config and auth tests**

`hub/test/config.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, DEFAULTS, loadConfig } from "../src/config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-web-config-"));

test("first run writes defaults (0600) and explains what to set", () => {
	const dir = tmp();
	assert.throws(() => loadConfig(dir), (e: unknown) => e instanceof ConfigError && /hostname and allowedLogin/.test(e.message));
	const file = join(dir, "config.json");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), DEFAULTS);
	assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a filled-in config loads with defaults merged and dataDir set", () => {
	const dir = tmp();
	writeFileSync(join(dir, "config.json"), JSON.stringify({ hostname: "spark-713a.tail9274fa.ts.net:7878", allowedLogin: "michaelthatsit@github" }));
	const cfg = loadConfig(dir);
	assert.equal(cfg.port, 7878);
	assert.equal(cfg.maxHeadless, 6);
	assert.deepEqual(cfg.allowedOrigins, ["https://pi.thatsit.dev"]);
	assert.equal(cfg.dataDir, dir);
});

test("dev mode adds the Vite dev origin", () => {
	const dir = tmp();
	writeFileSync(join(dir, "config.json"), JSON.stringify({ hostname: "localhost:5173", allowedLogin: "dev@local", dev: true }));
	assert.ok(loadConfig(dir).allowedOrigins.includes("http://localhost:5173"));
});
```

`hub/test/auth.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRequest, corsHeaders } from "../src/auth.ts";

const cfg = { hostname: "spark-713a.tail9274fa.ts.net:7878", allowedLogin: "michaelthatsit@github", allowedOrigins: ["https://pi.thatsit.dev"] };
const good = { origin: "https://pi.thatsit.dev", host: "spark-713a.tail9274fa.ts.net:7878", "tailscale-user-login": "michaelthatsit@github" };

test("accepts the allowed origin, host and login", () => {
	assert.deepEqual(checkRequest(cfg, good), { ok: true });
});

test("accepts the tailnet host via X-Forwarded-Host when tailscale rewrote Host", () => {
	assert.deepEqual(checkRequest(cfg, { ...good, host: "127.0.0.1:7878", "x-forwarded-host": cfg.hostname }), { ok: true });
});

const rejects: Array<[string, Record<string, string | undefined>]> = [
	["missing origin", { ...good, origin: undefined }],
	["other website", { ...good, origin: "https://evil.example" }],
	["origin with path tricks", { ...good, origin: "https://pi.thatsit.dev.evil.example" }],
	["wrong host (DNS rebinding)", { ...good, host: "evil.example:7878" }],
	["no tailscale identity", { ...good, "tailscale-user-login": undefined }],
	["someone else on the tailnet", { ...good, "tailscale-user-login": "guest@github" }],
];
for (const [name, headers] of rejects) {
	test(`rejects: ${name}`, () => {
		assert.equal(checkRequest(cfg, headers).ok, false);
	});
}

test("CORS headers only echo an allowed origin", () => {
	assert.equal(corsHeaders(cfg, "https://pi.thatsit.dev")["access-control-allow-origin"], "https://pi.thatsit.dev");
	assert.deepEqual(corsHeaders(cfg, "https://evil.example"), {});
	assert.deepEqual(corsHeaders(cfg, undefined), {});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w hub`
Expected: FAIL, with module-not-found errors for `config.ts` and `auth.ts`.

- [ ] **Step 4: Implement config and auth**

`hub/src/config.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HubConfig {
	port: number;
	hostname: string; // tailnet host:port the browser uses, e.g. spark-713a.tail9274fa.ts.net:7878
	allowedLogin: string; // Tailscale-User-Login value allowed in, e.g. michaelthatsit@github
	allowedOrigins: string[];
	idleMinutes: number;
	maxHeadless: number;
	piBin: string;
	dev: boolean;
	dataDir: string;
}

export const DEFAULTS = {
	port: 7878,
	hostname: "",
	allowedLogin: "",
	allowedOrigins: ["https://pi.thatsit.dev"],
	idleMinutes: 20,
	maxHeadless: 6,
	piBin: "pi",
	dev: false,
};

export const DEV_ORIGIN = "http://localhost:5173";

export class ConfigError extends Error {}

export function defaultDataDir(): string {
	return process.env.PI_WEB_DATA_DIR || join(homedir(), ".config", "pi-web");
}

export function loadConfig(dataDir = defaultDataDir()): HubConfig {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const file = join(dataDir, "config.json");
	if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`, { mode: 0o600 });
	const cfg: HubConfig = { ...DEFAULTS, ...JSON.parse(readFileSync(file, "utf8")), dataDir };
	if (!cfg.hostname || !cfg.allowedLogin) {
		throw new ConfigError(
			`Set hostname and allowedLogin in ${file}.\n` +
				`  hostname: the tailnet host:port you open in the browser (run \`tailscale status --json\`, Self.DNSName, plus :${cfg.port})\n` +
				"  allowedLogin: your Tailscale login, e.g. michaelthatsit@github",
		);
	}
	if (cfg.dev && !cfg.allowedOrigins.includes(DEV_ORIGIN)) cfg.allowedOrigins = [...cfg.allowedOrigins, DEV_ORIGIN];
	return cfg;
}
```

`hub/src/auth.ts`:

```ts
// Every request must come from an allowed page (Origin), to the tailnet host
// (Host), as the allowed Tailscale user. The identity header is ambient: tailscale
// serve adds it to any request this device makes, including ones another
// website triggers, so the Origin check is what makes it safe (spec §6).

import type { IncomingHttpHeaders } from "node:http";
import type { HubConfig } from "./config.ts";

type AuthConfig = Pick<HubConfig, "hostname" | "allowedLogin" | "allowedOrigins">;
export type AuthResult = { ok: true } | { ok: false; reason: string };

export function checkRequest(cfg: AuthConfig, h: IncomingHttpHeaders): AuthResult {
	const origin = h.origin;
	if (!origin || !cfg.allowedOrigins.includes(origin)) return { ok: false, reason: `origin ${origin ?? "(none)"}` };
	// tailscale serve may forward the original host as X-Forwarded-Host. A client
	// that could forge that header is not a browser, and cannot get the identity
	// header either unless it runs on this machine as this user.
	if (h.host !== cfg.hostname && h["x-forwarded-host"] !== cfg.hostname) return { ok: false, reason: `host ${h.host}` };
	const login = h["tailscale-user-login"];
	if (login !== cfg.allowedLogin) return { ok: false, reason: `login ${login ?? "(none)"}` };
	return { ok: true };
}

export function corsHeaders(cfg: Pick<HubConfig, "allowedOrigins">, origin: string | undefined): Record<string, string> {
	if (!origin || !cfg.allowedOrigins.includes(origin)) return {};
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "content-type",
		"access-control-max-age": "600",
		vary: "Origin",
	};
}
```

- [ ] **Step 5: Run the tests and typecheck to verify they pass**

Run: `npm test -w hub && npm run typecheck -w hub`
Expected: all config and auth tests pass, and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add hub package-lock.json
git commit -m "feat(hub): config loading and origin/host/identity checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Session discovery from disk

**Files:**
- Create: `hub/src/jsonl.ts`, `hub/src/sessions.ts`
- Test: `hub/test/jsonl.test.ts`, `hub/test/sessions.test.ts`

**Interfaces:**
- Consumes: `AgentMessage`, `SessionSummary` and `contentText` from shared.
- Produces:
  - `lineSplitter(onLine: (line: string) => void): (chunk: string) => void`
  - `sessionsDir(env?: NodeJS.ProcessEnv, home?: string): string`
  - `type FileSummary = Omit<SessionSummary, "live" | "handleKind" | "state"> & { file: string }`
  - `class SessionIndex { constructor(dir: string); list(): Promise<FileSummary[]>; find(id: string): Promise<FileSummary | null> }`
  - `readHistory(file: string): Promise<AgentMessage[]>`
  - `historyFromText(text: string): AgentMessage[]`
  - `knownCwds(summaries: FileSummary[], home: string): string[]`

- [ ] **Step 1: Write the failing tests**

`hub/test/jsonl.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { lineSplitter } from "../src/jsonl.ts";

test("splits on LF only, across chunk boundaries, stripping CR", () => {
	const lines: string[] = [];
	const push = lineSplitter((l) => lines.push(l));
	const sep = JSON.stringify({ text: "a b c" }); // valid JSON containing Unicode separators
	push(`{"a":1}\r\n${sep.slice(0, 5)}`);
	push(`${sep.slice(5)}\n\n{"b"`);
	push(":2}\n");
	assert.deepEqual(lines, ['{"a":1}', sep, '{"b":2}']);
	assert.equal(JSON.parse(lines[1]).text, "a b c");
});
```

`hub/test/sessions.test.ts`:

```ts
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionIndex, historyFromText, knownCwds, sessionsDir } from "../src/sessions.ts";

const line = (o: object) => `${JSON.stringify(o)}\n`;
const header = (id: string, cwd: string, ts = "2026-10-07T01:23:32.125Z") => line({ type: "session", version: 3, id, timestamp: ts, cwd });
const msg = (id: string, parentId: string | null, message: object) => line({ type: "message", id, parentId, timestamp: "2026-10-07T01:23:33.000Z", message });
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text: string, stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	provider: "spark",
	model: "qwen3.8-27b",
	usage: { input: 1000, output: 50, cacheRead: 200, cacheWrite: 0, totalTokens: 1250 },
	stopReason,
	timestamp: 2,
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-web-sessions-"));
	const home = join(root, "--home-michael--");
	const site = join(root, "--home-michael-workspace-website--");
	mkdirSync(home);
	mkdirSync(site);
	writeFileSync(
		join(home, "2026-10-07T01-23-32-125Z_aaa.jsonl"),
		header("aaa", "/nonexistent/home") +
			line({ type: "model_change", id: "m1", parentId: null, timestamp: "x", provider: "spark", modelId: "qwen3.6-35b-a3b-sglang" }) +
			msg("s1", "m1", { role: "system", content: "", timestamp: 0 }) +
			msg("u1", "s1", user("How do I reheat a katsu sandwich?")) +
			msg("a1", "u1", assistant("Air fryer, 180C.")) +
			msg("a2", "a1", assistant("partial", "aborted")) +
			line({ type: "session_info", id: "i1", parentId: "a2", timestamp: "x", name: "katsu" }) +
			'{"type":"message","id":"half', // half-written last line
	);
	writeFileSync(join(site, "2026-10-08T00-00-00-000Z_bbb.jsonl"), header("bbb", "/nonexistent/website", "2026-10-08T00:00:00.000Z") + msg("u1", null, user("portfolio?")));
	writeFileSync(join(site, "not-a-session.jsonl"), line({ type: "message", id: "x", parentId: null, message: user("no header") }));
	writeFileSync(join(site, "notes.txt"), "ignore me");
	writeFileSync(join(root, "stray.jsonl"), header("ccc", "/tmp")); // not inside a session subdirectory
	return { root, home, site };
}

test("sessionsDir follows pi's precedence", () => {
	assert.equal(sessionsDir({ PI_CODING_AGENT_SESSION_DIR: "/x/sessions" }, "/home/m"), "/x/sessions");
	assert.equal(sessionsDir({}, "/home/m"), "/home/m/.pi/agent/sessions");
	assert.equal(sessionsDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/m"), "/tmp/agent/sessions");
	const agent = mkdtempSync(join(tmpdir(), "pi-web-agent-"));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ sessionDir: "~/pi-sessions" }));
	assert.equal(sessionsDir({ PI_CODING_AGENT_DIR: agent }, "/home/m"), "/home/m/pi-sessions");
});

test("lists valid sessions newest first and skips files without a header", async () => {
	const { root } = fixture();
	const list = await new SessionIndex(root).list();
	assert.deepEqual(list.map((s) => s.id).sort(), ["aaa", "bbb"]);
	const aaa = list.find((s) => s.id === "aaa");
	assert.ok(aaa);
	assert.equal(aaa.cwd, "/nonexistent/home");
	assert.equal(aaa.name, "katsu");
	assert.equal(aaa.firstPrompt, "How do I reheat a katsu sandwich?");
	assert.equal(aaa.userMessages, 1);
	assert.equal(aaa.model, "spark/qwen3.8-27b");
	assert.equal(aaa.contextTokens, 1250); // last non-aborted assistant usage
	assert.equal(aaa.createdAt, Date.parse("2026-10-07T01:23:32.125Z"));
	assert.ok(list[0].updatedAt >= list[1].updatedAt);
});

test("re-parses a session after it changes on disk", async () => {
	const { root, site } = fixture();
	const index = new SessionIndex(root);
	assert.equal((await index.find("bbb"))?.name, null);
	appendFileSync(join(site, "2026-10-08T00-00-00-000Z_bbb.jsonl"), line({ type: "session_info", id: "i9", parentId: "u1", timestamp: "x", name: "portfolio" }));
	assert.equal((await index.find("bbb"))?.name, "portfolio");
	assert.equal(await index.find("nope"), null);
});

test("history follows the active branch and renders compaction and branch summaries", () => {
	const text =
		header("h", "/x") +
		msg("u1", null, user("first")) +
		msg("a1", "u1", assistant("old answer")) +
		msg("a1b", "u1", assistant("branched answer")) + // sibling of a1
		line({ type: "compaction", id: "c1", parentId: "a1b", timestamp: "2026-10-07T02:00:00.000Z", summary: "talked about X", firstKeptEntryId: "a1b", tokensBefore: 50000 }) +
		line({ type: "branch_summary", id: "b1", parentId: "c1", timestamp: "2026-10-07T02:01:00.000Z", fromId: "a1", summary: "tried Y" }) +
		line({ type: "custom_message", id: "x1", parentId: "b1", timestamp: "2026-10-07T02:02:00.000Z", customType: "goal", content: "ship it", display: true }) +
		line({ type: "custom", id: "x2", parentId: "x1", timestamp: "x", customType: "state", data: {} }) +
		msg("u2", "x2", user("second"));
	const roles = historyFromText(text).map((m) => m.role);
	assert.deepEqual(roles, ["user", "assistant", "compactionSummary", "branchSummary", "custom", "user"]);
	const h = historyFromText(text);
	assert.equal((h[1].content as Array<{ text: string }>)[0].text, "branched answer");
	assert.equal(h[2].tokensBefore, 50000);
});

test("knownCwds ranks folders by session count and always includes home", async () => {
	const { root } = fixture();
	const list = await new SessionIndex(root).list();
	const home = mkdtempSync(join(tmpdir(), "pi-web-home-"));
	// Fixture cwds don't exist on this machine, so only the real home survives the existence filter.
	assert.deepEqual(knownCwds(list, home), [home]);
	assert.deepEqual(knownCwds([{ ...list[0], cwd: tmpdir() }, { ...list[1], cwd: tmpdir() }], home), [tmpdir(), home]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w hub`
Expected: FAIL, with module-not-found errors for `jsonl.ts` and `sessions.ts`.

- [ ] **Step 3: Implement the line splitter and session discovery**

`hub/src/jsonl.ts`:

```ts
// Pi's JSONL protocols split records on LF only. JSON strings may contain
// U+2028/U+2029, which node:readline would treat as line breaks.
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
	let buf = "";
	return (chunk) => {
		buf += chunk;
		let nl = buf.indexOf("\n");
		while (nl !== -1) {
			const line = buf.slice(0, nl).replace(/\r$/, "");
			buf = buf.slice(nl + 1);
			if (line) onLine(line);
			nl = buf.indexOf("\n");
		}
	};
}
```

`hub/src/sessions.ts`:

```ts
// Finds pi sessions on disk so ones started from the CLI show up next to ones
// started from the app. Each file is parsed once per (mtime, size).

import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, SessionSummary } from "../../shared/src/protocol.ts";
import { contentText } from "../../shared/src/reducer.ts";

export type FileSummary = Omit<SessionSummary, "live" | "handleKind" | "state"> & { file: string };

type Entry = Record<string, any>;

export function sessionsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	if (env.PI_CODING_AGENT_SESSION_DIR) return env.PI_CODING_AGENT_SESSION_DIR;
	const agentDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
	try {
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		if (typeof settings.sessionDir === "string" && settings.sessionDir) return settings.sessionDir.replace(/^~(?=\/|$)/, home);
	} catch {}
	return join(agentDir, "sessions");
}

function parseEntries(text: string): Entry[] {
	const out: Entry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {} // half-written or corrupt line
	}
	return out;
}

export function summarize(file: string, text: string, mtimeMs: number): FileSummary | null {
	const entries = parseEntries(text);
	const header = entries[0];
	if (header?.type !== "session" || typeof header.id !== "string") return null;
	let name: string | null = null;
	let firstPrompt: string | null = null;
	let userMessages = 0;
	let model: string | null = null;
	let contextTokens: number | null = null;
	for (const e of entries) {
		if (e.type === "session_info") name = e.name || null;
		else if (e.type === "model_change") model = `${e.provider}/${e.modelId}`;
		else if (e.type === "message") {
			const m = e.message;
			if (m?.role === "user") {
				userMessages++;
				firstPrompt ??= contentText(m.content).trim().slice(0, 200) || null;
			} else if (m?.role === "assistant") {
				if (m.provider && m.model) model = `${m.provider}/${m.model}`;
				const u = m.usage;
				if (u && m.stopReason !== "aborted" && m.stopReason !== "error") contextTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
			}
		}
	}
	return {
		id: header.id,
		file,
		cwd: header.cwd,
		name,
		firstPrompt,
		userMessages,
		model,
		contextTokens,
		createdAt: Date.parse(header.timestamp) || mtimeMs,
		updatedAt: mtimeMs,
		parentSession: header.parentSession ?? null,
	};
}

export class SessionIndex {
	readonly dir: string;
	private cache = new Map<string, { mtimeMs: number; size: number; summary: FileSummary | null }>();

	constructor(dir: string) {
		this.dir = dir;
	}

	async list(): Promise<FileSummary[]> {
		if (!existsSync(this.dir)) return [];
		const out: FileSummary[] = [];
		for (const sub of await readdir(this.dir, { withFileTypes: true })) {
			if (!sub.isDirectory()) continue;
			const subdir = join(this.dir, sub.name);
			let names: string[];
			try {
				names = await readdir(subdir);
			} catch {
				continue;
			}
			for (const name of names) {
				if (!name.endsWith(".jsonl")) continue;
				const file = join(subdir, name);
				try {
					const st = await stat(file);
					let hit = this.cache.get(file);
					if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
						hit = { mtimeMs: st.mtimeMs, size: st.size, summary: summarize(file, await readFile(file, "utf8"), st.mtimeMs) };
						this.cache.set(file, hit);
					}
					if (hit.summary) out.push(hit.summary);
				} catch {} // file vanished between readdir and stat
			}
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async find(id: string): Promise<FileSummary | null> {
		return (await this.list()).find((s) => s.id === id) ?? null;
	}
}

// Messages on the active branch: walk from the last entry back to the root.
export function historyFromText(text: string): AgentMessage[] {
	const entries = parseEntries(text);
	const byId = new Map<string, Entry>();
	for (const e of entries) if (e.id) byId.set(e.id, e);
	const path: Entry[] = [];
	for (let e = entries.findLast((x) => x.id); e; e = e.parentId ? byId.get(e.parentId) : undefined) path.push(e);
	path.reverse();
	const out: AgentMessage[] = [];
	for (const e of path) {
		const ts = Date.parse(e.timestamp);
		if (e.type === "message" && e.message?.role !== "system") out.push(e.message);
		else if (e.type === "compaction") out.push({ role: "compactionSummary", summary: e.summary, tokensBefore: e.tokensBefore, timestamp: ts });
		else if (e.type === "branch_summary") out.push({ role: "branchSummary", summary: e.summary, timestamp: ts });
		else if (e.type === "custom_message" && e.display) out.push({ role: "custom", customType: e.customType, content: e.content, display: true, timestamp: ts });
	}
	return out;
}

export async function readHistory(file: string): Promise<AgentMessage[]> {
	return historyFromText(await readFile(file, "utf8"));
}

export function knownCwds(summaries: FileSummary[], home: string): string[] {
	const counts = new Map<string, number>();
	for (const s of summaries) if (s.cwd) counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
	if (!counts.has(home)) counts.set(home, 0);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([cwd]) => cwd)
		.filter((cwd) => existsSync(cwd));
}
```

- [ ] **Step 4: Run the tests and typecheck to verify they pass**

Run: `npm test -w hub && npm run typecheck -w hub`
Expected: all tests pass, including the half-written line and the header-less file, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add hub
git commit -m "feat(hub): discover pi sessions on disk and read active-branch history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Test harness: fake model server and isolated pi environment

The integration tests in Tasks 5, 7 and 16 run the **real** `pi` binary against a scripted OpenAI-compatible server in a temporary `PI_CODING_AGENT_DIR`. A probe while writing this plan confirmed that pi 1.0.2 streams `reasoning_content` as thinking and `content` as text, and that extension dialogs arrive as `extension_ui_request` records in that setup.

**Files:**
- Create: `hub/test/support/fake-model.ts`, `hub/test/support/pi-env.ts`
- Test: `hub/test/harness.test.ts`

**Interfaces:**
- Produces:
  - `startFakeModel(script?: FakeScript): Promise<FakeModel>`, where `FakeModel = { url: string; requests: FakeRequest[]; setScript(s: FakeScript): void; close(): Promise<void> }` and `FakeScript = (req: FakeRequest, n: number) => FakeReply`
  - `FakeReply = { thinking?: string; text?: string; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[]; chunkDelayMs?: number; status?: number }`
  - `makePiEnv(opts: { modelUrl: string; extensions?: Record<string, string> }): PiEnv`, where `PiEnv = { root; agentDir; workDir; piBin; env: Record<string, string>; cleanup(): void }`
  - The test extension `/ask` (in every PiEnv) opens `select("Pick one", ["red", "blue"])` and then notifies `picked <value>`.

- [ ] **Step 1: Write the fake model server**

`hub/test/support/fake-model.ts`:

```ts
// A scripted OpenAI-compatible chat-completions server. pi talks to it through
// a "fake" provider in a temp models.json, so tests are fast, deterministic and
// never touch the real models on spark.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface FakeRequest {
	model: string;
	messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
	tools?: unknown[];
}

export interface FakeReply {
	thinking?: string;
	text?: string;
	toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
	chunkDelayMs?: number;
	status?: number; // non-200 → JSON error response
}

export type FakeScript = (req: FakeRequest, n: number) => FakeReply;

export interface FakeModel {
	url: string;
	requests: FakeRequest[];
	setScript(script: FakeScript): void;
	close(): Promise<void>;
}

export const HELLO: FakeScript = () => ({ thinking: "pondering", text: "Hello world" });

export async function startFakeModel(script: FakeScript = HELLO): Promise<FakeModel> {
	let current = script;
	const requests: FakeRequest[] = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		if (!req.url?.endsWith("/chat/completions")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [] }));
			return;
		}
		const parsed = JSON.parse(body) as FakeRequest;
		requests.push(parsed);
		const reply = current(parsed, requests.length);
		if (reply.status && reply.status !== 200) {
			res.writeHead(reply.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `fake error ${reply.status}` } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
		let closed = false;
		res.on("close", () => {
			closed = true;
		});
		const send = async (choices: unknown[], extra: object = {}) => {
			if (closed) return;
			res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: parsed.model, choices, ...extra })}\n\n`);
			if (reply.chunkDelayMs) await sleep(reply.chunkDelayMs);
		};
		const delta = (d: object, finish: string | null = null) => send([{ index: 0, delta: d, finish_reason: finish }]);
		await delta({ role: "assistant" });
		if (reply.thinking) await delta({ reasoning_content: reply.thinking });
		for (const word of reply.text?.match(/\S+\s*/g) ?? []) await delta({ content: word });
		for (const [index, call] of (reply.toolCalls ?? []).entries()) {
			await delta({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
		}
		await delta({}, reply.toolCalls?.length ? "tool_calls" : "stop");
		await send([], { usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
		if (!closed) res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		setScript: (s) => {
			current = s;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
```

- [ ] **Step 2: Write the pi environment helper**

`hub/test/support/pi-env.ts`:

```ts
// A throwaway PI_CODING_AGENT_DIR: fake provider with two models, no user
// extensions, plus a tiny /ask extension for dialog tests.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PiEnv {
	root: string;
	agentDir: string;
	workDir: string;
	piBin: string;
	env: Record<string, string>;
	cleanup(): void;
}

export const ASK_EXTENSION = `
export default function (pi) {
	pi.registerCommand("ask", {
		description: "test dialog",
		handler: async (_args, ctx) => {
			const value = await ctx.ui.select("Pick one", ["red", "blue"]);
			ctx.ui.notify("picked " + value, "info");
		},
	});
}
`;

export function makePiEnv(opts: { modelUrl: string; extensions?: Record<string, string> }): PiEnv {
	const root = mkdtempSync(join(tmpdir(), "pi-web-pi-"));
	const agentDir = join(root, "agent");
	const workDir = join(root, "work");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(workDir);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: opts.modelUrl,
					api: "openai-completions",
					apiKey: "test",
					compat: { supportsDeveloperRole: false },
					models: [
						{ id: "fake-a", name: "Fake A", reasoning: true, input: ["text", "image"], contextWindow: 1000, maxTokens: 100 },
						{ id: "fake-b", name: "Fake B", reasoning: false, input: ["text"], contextWindow: 2000, maxTokens: 100 },
					],
				},
			},
		}),
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-a" }));
	for (const [name, source] of Object.entries({ "ask.ts": ASK_EXTENSION, ...opts.extensions })) {
		writeFileSync(join(agentDir, "extensions", name), source);
	}
	return {
		root,
		agentDir,
		workDir,
		piBin: process.env.PI_BIN ?? "pi",
		env: { PI_CODING_AGENT_DIR: agentDir },
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
```

- [ ] **Step 3: Write the harness smoke test**

`hub/test/harness.test.ts`:

```ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { lineSplitter } from "../src/jsonl.ts";
import { type FakeModel, startFakeModel } from "./support/fake-model.ts";
import { makePiEnv } from "./support/pi-env.ts";

let model: FakeModel;
before(async () => {
	model = await startFakeModel();
});
after(() => model.close());

test("real pi in RPC mode streams the fake model's reply", async () => {
	const env = makePiEnv({ modelUrl: model.url });
	try {
		const proc = spawn(env.piBin, ["--mode", "rpc", "--no-session"], { cwd: env.workDir, env: { ...process.env, ...env.env } });
		const records: Array<{ type: string; assistantMessageEvent?: { type: string; delta?: string } }> = [];
		const settled = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("pi did not settle within 20s")), 20_000);
			proc.stdout.setEncoding("utf8");
			proc.stdout.on(
				"data",
				lineSplitter((line) => {
					const rec = JSON.parse(line);
					records.push(rec);
					if (rec.type === "agent_settled") {
						clearTimeout(timer);
						resolve();
					}
				}),
			);
		});
		proc.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: "hi" })}\n`);
		await settled;
		proc.stdin.end();
		const text = records
			.filter((r) => r.assistantMessageEvent?.type === "text_delta")
			.map((r) => r.assistantMessageEvent?.delta)
			.join("");
		assert.equal(text, "Hello world");
		assert.equal(model.requests.at(-1)?.model, "fake-a");
	} finally {
		env.cleanup();
	}
});
```

- [ ] **Step 4: Run the test**

Run: `npm test -w hub -- --test-name-pattern="real pi"`
Expected: PASS in a few seconds. If it fails with `spawn pi ENOENT`, export `PI_BIN=$(command -v pi)`, which is `/home/michael/.local/bin/pi` on spark.

- [ ] **Step 5: Commit**

```bash
git add hub/test
git commit -m "test(hub): fake OpenAI-compatible model and isolated pi environment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: RpcHandle: one headless pi per session

**Files:**
- Create: `hub/src/translate.ts`, `hub/src/handle.ts`, `hub/src/rpc-handle.ts`
- Test: `hub/test/translate.test.ts`, `hub/test/rpc-handle.test.ts`

**Interfaces:**
- Consumes: `lineSplitter` (Task 3), `HttpError` (Task 2), the shared reducer and protocol (Task 1), and the harness (Task 4).
- Produces:
  - `toRpc(cmd: RpcTranslatable): RpcCommand`, where `RpcTranslatable = Exclude<AppCommand, { type: "attach" } | { type: "export" }>` and `RpcCommand = { type: string; [k: string]: unknown }`
  - `interface SessionHandle` and `type HandleEvent` (code below). Tasks 6–7 and Plan 2's `BridgeHandle` implement or consume these.
  - `class RpcHandle implements SessionHandle`, with `static start(opts: RpcHandleOptions): Promise<RpcHandle>`, where `RpcHandleOptions = { piBin: string; cwd: string; sessionFile?: string; exportDir: string; env?: Record<string, string>; promptAckMs?: number }`
  - `stripAnsi(s: string): string`

- [ ] **Step 1: Write the failing translation test**

`hub/test/translate.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { toRpc } from "../src/translate.ts";

test("app commands map to pi RPC commands", () => {
	assert.deepEqual(toRpc({ type: "prompt", text: "hi", mode: "send" }), { type: "prompt", message: "hi" });
	assert.deepEqual(toRpc({ type: "prompt", text: "stop", mode: "steer" }), { type: "prompt", message: "stop", streamingBehavior: "steer" });
	assert.deepEqual(toRpc({ type: "prompt", text: "look", mode: "followUp", images: [{ data: "AAAA", mimeType: "image/png" }] }), {
		type: "prompt",
		message: "look",
		images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
		streamingBehavior: "followUp",
	});
	assert.deepEqual(toRpc({ type: "set_thinking", level: "high" }), { type: "set_thinking_level", level: "high" });
	assert.deepEqual(toRpc({ type: "compact" }), { type: "compact" });
	assert.deepEqual(toRpc({ type: "compact", instructions: "keep the API decisions" }), { type: "compact", customInstructions: "keep the API decisions" });
	assert.deepEqual(toRpc({ type: "rename", name: "portfolio" }), { type: "set_session_name", name: "portfolio" });
	assert.deepEqual(toRpc({ type: "get_fork_points" }), { type: "get_fork_messages" });
	assert.deepEqual(toRpc({ type: "bash", command: "ls", excludeFromContext: true }), { type: "bash", command: "ls", excludeFromContext: true });
	assert.deepEqual(toRpc({ type: "dialog_response", id: "d1", value: "blue" }), { type: "extension_ui_response", id: "d1", value: "blue" });
	assert.deepEqual(toRpc({ type: "dialog_response", id: "d2", cancelled: true }), { type: "extension_ui_response", id: "d2", cancelled: true });
});
```

- [ ] **Step 2: Run the test to verify it fails, then implement `translate.ts` and `handle.ts`**

Run: `npm test -w hub -- --test-name-pattern="map to pi RPC"`
Expected: FAIL, with module not found.

`hub/src/translate.ts`:

```ts
import type { AppCommand } from "../../shared/src/protocol.ts";

export type RpcCommand = { type: string; [key: string]: unknown };
export type RpcTranslatable = Exclude<AppCommand, { type: "attach" } | { type: "export" }>;

export function toRpc(cmd: RpcTranslatable): RpcCommand {
	switch (cmd.type) {
		case "prompt":
			return {
				type: "prompt",
				message: cmd.text,
				...(cmd.images?.length ? { images: cmd.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : {}),
				...(cmd.mode === "send" ? {} : { streamingBehavior: cmd.mode }),
			};
		case "abort":
			return { type: "abort" };
		case "set_model":
			return { type: "set_model", provider: cmd.provider, modelId: cmd.modelId };
		case "set_thinking":
			return { type: "set_thinking_level", level: cmd.level };
		case "compact":
			return cmd.instructions ? { type: "compact", customInstructions: cmd.instructions } : { type: "compact" };
		case "rename":
			return { type: "set_session_name", name: cmd.name };
		case "get_fork_points":
			return { type: "get_fork_messages" };
		case "fork":
			return { type: "fork", entryId: cmd.entryId };
		case "clone":
			return { type: "clone" };
		case "new_session":
			return { type: "new_session" };
		case "bash":
			return { type: "bash", command: cmd.command, excludeFromContext: cmd.excludeFromContext };
		case "dialog_response": {
			const { type: _type, ...rest } = cmd;
			return { type: "extension_ui_response", ...rest };
		}
		case "clear_queue":
			return { type: "clear_queue" };
		case "get_last_assistant_text":
			return { type: "get_last_assistant_text" };
	}
}
```

`hub/src/handle.ts`:

```ts
// The seam between the hub and "something running a pi session". RpcHandle
// (headless child, this plan) and BridgeHandle (terminal pi, Plan 2) implement it.

import type { AppCommand, Capabilities, CommandResult, HandleKind, LiveState, Snapshot, StreamMessage } from "../../shared/src/protocol.ts";

export type HandleEvent =
	| { type: "state_changed" }
	| { type: "renamed" }
	| { type: "session_changed"; from: string; to: string }
	| { type: "exit"; code: number | null; stderr: string; closedByHub: boolean };

export interface SessionHandle {
	readonly kind: HandleKind;
	readonly sessionId: string;
	readonly sessionFile: string | null;
	readonly cwd: string;
	readonly pid: number;
	readonly capabilities: Capabilities;
	lastActive: number;
	subscriberCount(): number;
	isBusy(): boolean; // running, compacting, or waiting on a dialog
	liveState(): LiveState;
	snapshot(): Snapshot;
	command(cmd: AppCommand): Promise<CommandResult>;
	subscribe(fn: (msg: StreamMessage) => void): () => void;
	onEvent(fn: (e: HandleEvent) => void): () => void;
	close(): void;
}
```

Run: `npm test -w hub -- --test-name-pattern="map to pi RPC"`
Expected: PASS.

- [ ] **Step 3: Write the failing RpcHandle integration tests**

`hub/test/rpc-handle.test.ts`:

```ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import type { AgentMessage, StreamMessage } from "../../shared/src/protocol.ts";
import { HttpError } from "../src/errors.ts";
import type { HandleEvent } from "../src/handle.ts";
import { RpcHandle } from "../src/rpc-handle.ts";
import { type FakeModel, type FakeScript, HELLO, startFakeModel } from "./support/fake-model.ts";
import { makePiEnv } from "./support/pi-env.ts";

let model: FakeModel;
before(async () => {
	model = await startFakeModel();
});
after(() => model.close());

async function startHandle(t: TestContext, script: FakeScript = HELLO, sessionFile?: string, env = makePiEnv({ modelUrl: model.url })) {
	model.setScript(script);
	const h = await RpcHandle.start({ piBin: env.piBin, cwd: env.workDir, sessionFile, exportDir: join(env.root, "exports"), env: env.env, promptAckMs: 500 });
	t.after(() => {
		h.close();
		if (!sessionFile) env.cleanup();
	});
	return { h, env };
}

// Records everything a subscriber sees and lets a test wait for a match.
function watch(h: RpcHandle) {
	const seen: StreamMessage[] = [];
	const waiters: Array<{ pred: (m: StreamMessage) => boolean; resolve: (m: StreamMessage) => void }> = [];
	h.subscribe((m) => {
		seen.push(m);
		for (const w of [...waiters]) {
			if (!w.pred(m)) continue;
			waiters.splice(waiters.indexOf(w), 1);
			w.resolve(m);
		}
	});
	return {
		seen,
		next(pred: (m: StreamMessage) => boolean, timeoutMs = 15_000): Promise<StreamMessage> {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timed out waiting for stream message")), timeoutMs);
				waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
			});
		},
	};
}
const isEvent = (type: string) => (m: StreamMessage) => m.type === "event" && m.event.type === type;
const lastAssistant = (msgs: AgentMessage[]) => msgs.findLast((m) => m.role === "assistant");
const textOf = (m?: AgentMessage) => (Array.isArray(m?.content) ? m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("") : "");

test("boots a new session with models, commands and thinking levels", async (t) => {
	const { h } = await startHandle(t);
	const s = h.snapshot();
	assert.ok(s.sessionId);
	assert.equal(s.handleKind, "rpc");
	assert.equal(s.capabilities.dialogs, "here");
	assert.equal(s.state.model?.id, "fake-a");
	assert.deepEqual(s.models.map((m) => m.id), ["fake-a", "fake-b"]);
	assert.ok(s.commands.some((c) => c.name === "ask"));
	assert.ok(s.thinkingLevels.includes("off"));
	assert.equal(h.liveState(), "idle");
});

test("streams a prompt, settles, and refreshes stats", async (t) => {
	const { h } = await startHandle(t);
	const w = watch(h);
	const states: HandleEvent[] = [];
	h.onEvent((e) => states.push(e));
	assert.deepEqual(await h.command({ type: "prompt", text: "hi", mode: "send" }), { ok: true, data: { disposition: "started" } });
	await w.next(isEvent("agent_settled"));
	const meta = await w.next((m) => m.type === "meta");
	assert.equal(meta.type === "meta" && meta.stats?.contextUsage?.contextWindow, 1000);
	assert.equal(textOf(lastAssistant(h.snapshot().conv.messages)), "Hello world");
	assert.ok(states.some((e) => e.type === "state_changed"));
	assert.equal(h.isBusy(), false);
});

test("runs a tool call and records the result", async (t) => {
	const script: FakeScript = (req) =>
		req.messages.at(-1)?.role === "tool" ? { text: "done" } : { toolCalls: [{ id: "call_1", name: "bash", args: { command: "echo hi-from-tool" } }] };
	const { h } = await startHandle(t, script);
	const w = watch(h);
	await h.command({ type: "prompt", text: "run it", mode: "send" });
	await w.next(isEvent("agent_settled"));
	const conv = h.snapshot().conv;
	assert.equal(conv.tools.call_1?.running, false);
	const result = conv.messages.find((m) => m.role === "toolResult");
	assert.match(textOf(result), /hi-from-tool/);
	assert.equal(textOf(lastAssistant(conv.messages)), "done");
});

test("switches model and thinking level", async (t) => {
	const { h } = await startHandle(t);
	assert.equal((await h.command({ type: "set_model", provider: "fake", modelId: "fake-b" })).ok, true);
	assert.equal(h.snapshot().state.model?.id, "fake-b");
	assert.deepEqual(h.snapshot().thinkingLevels, ["off"]);
	await h.command({ type: "set_model", provider: "fake", modelId: "fake-a" });
	await h.command({ type: "set_thinking", level: "high" });
	assert.equal(h.snapshot().state.thinkingLevel, "high");
	assert.equal((await h.command({ type: "set_model", provider: "fake", modelId: "nope" })).ok, false);
});

test("a prompt that opens a dialog returns pending quickly; the answer reaches the extension", async (t) => {
	const { h } = await startHandle(t);
	const w = watch(h);
	const started = Date.now();
	const result = await h.command({ type: "prompt", text: "/ask", mode: "send" });
	assert.equal(result.ok, true);
	assert.ok(Date.now() - started < 2000, "command must not wait for the dialog");
	const d = await w.next((m) => m.type === "dialog");
	assert.ok(d.type === "dialog" && d.dialog.title === "Pick one" && d.dialog.method === "select");
	assert.equal(h.liveState(), "needs_you");
	assert.equal((await h.command({ type: "dialog_response", id: d.dialog.id, value: "blue" })).ok, true);
	const n = await w.next((m) => m.type === "notify");
	assert.ok(n.type === "notify" && n.message === "picked blue");
	assert.equal((await h.command({ type: "dialog_response", id: d.dialog.id, value: "red" })).ok, false);
});

test("abort stops a slow reply", async (t) => {
	const { h } = await startHandle(t, () => ({ text: "word ".repeat(80), chunkDelayMs: 50 }));
	const w = watch(h);
	await h.command({ type: "prompt", text: "talk", mode: "send" });
	await w.next((m) => m.type === "event" && m.event.assistantMessageEvent?.type === "text_delta");
	assert.equal((await h.command({ type: "abort" })).ok, true);
	await w.next(isEvent("agent_settled"));
	assert.equal(lastAssistant(h.snapshot().conv.messages)?.stopReason, "aborted");
});

test("reopens an existing session file with its history", async (t) => {
	const env = makePiEnv({ modelUrl: model.url });
	t.after(() => env.cleanup());
	const first = await RpcHandle.start({ piBin: env.piBin, cwd: env.workDir, exportDir: join(env.root, "exports"), env: env.env });
	const w = watch(first);
	await first.command({ type: "prompt", text: "remember me", mode: "send" });
	await w.next(isEvent("agent_settled"));
	const { sessionId, sessionFile } = first.snapshot();
	assert.ok(sessionFile);
	const exited = new Promise((r) => first.onEvent((e) => e.type === "exit" && r(e)));
	first.close();
	await exited;
	const { h } = await startHandle(t, HELLO, sessionFile, env);
	assert.equal(h.sessionId, sessionId);
	assert.ok(h.snapshot().conv.messages.some((m) => m.role === "user" && textOf(m) === "remember me"));
});

test("fork moves the handle to a new session and announces it", async (t) => {
	const { h } = await startHandle(t);
	const w = watch(h);
	await h.command({ type: "prompt", text: "fork from here", mode: "send" });
	await w.next(isEvent("agent_settled"));
	const points = await h.command({ type: "get_fork_points" });
	const first = (points.data as { messages: Array<{ entryId: string; text: string }> }).messages[0];
	assert.equal(first.text, "fork from here");
	const changed = new Promise<HandleEvent>((r) => h.onEvent((e) => e.type === "session_changed" && r(e)));
	const before = h.sessionId;
	assert.equal((await h.command({ type: "fork", entryId: first.entryId })).ok, true);
	const e = await changed;
	assert.ok(e.type === "session_changed" && e.from === before && e.to === h.sessionId && e.to !== before);
	assert.ok(w.seen.some((m) => m.type === "snapshot" && m.snapshot.sessionId === h.sessionId));
});

test("reports pi exiting unexpectedly", async (t) => {
	const { h } = await startHandle(t);
	const w = watch(h);
	const exit = new Promise<HandleEvent>((r) => h.onEvent((e) => e.type === "exit" && r(e)));
	process.kill(h.pid, "SIGKILL");
	const gone = await w.next((m) => m.type === "handle_gone");
	assert.ok(gone.type === "handle_gone" && gone.reason === "exit");
	const e = await exit;
	assert.ok(e.type === "exit" && e.closedByHub === false);
	assert.equal((await h.command({ type: "abort" })).ok, false);
});

test("close() is reported as a clean shutdown", async (t) => {
	const { h } = await startHandle(t);
	const w = watch(h);
	const exit = new Promise<HandleEvent>((r) => h.onEvent((e) => e.type === "exit" && r(e)));
	h.close();
	const gone = await w.next((m) => m.type === "handle_gone");
	assert.ok(gone.type === "handle_gone" && gone.reason === "closed");
	assert.ok(((await exit) as { closedByHub: boolean }).closedByHub);
});

test("fails fast with a 502 when pi can't start", async () => {
	const env = makePiEnv({ modelUrl: model.url });
	try {
		const started = Date.now();
		await assert.rejects(
			RpcHandle.start({ piBin: "/nonexistent/pi", cwd: env.workDir, exportDir: env.root, env: env.env }),
			(e: unknown) => e instanceof HttpError && e.status === 502 && /Couldn't start pi/.test(e.message),
		);
		assert.ok(Date.now() - started < 5000);
	} finally {
		env.cleanup();
	}
});

test("export writes an HTML file and returns its name", async (t) => {
	const { h, env } = await startHandle(t);
	const w = watch(h);
	await h.command({ type: "prompt", text: "hi", mode: "send" });
	await w.next(isEvent("agent_settled"));
	const r = await h.command({ type: "export" });
	assert.equal(r.ok, true);
	const name = (r.data as { name: string }).name;
	assert.match(name, /\.html$/);
	assert.ok(existsSync(join(env.root, "exports", name)));
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -w hub -- --test-name-pattern="session|prompt|tool|model|dialog|abort|fork|pi|close|export"`
Expected: FAIL, because `rpc-handle.ts` doesn't exist.

- [ ] **Step 5: Implement RpcHandle**

`hub/src/rpc-handle.ts`:

```ts
// One headless `pi --mode rpc` child bound to a session. Keeps the conversation,
// stats and extension UI state so any browser that attaches gets a complete
// snapshot, then relays live events to every subscriber.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AgentMessage,
	AppCommand,
	Capabilities,
	CommandInfo,
	CommandResult,
	Conversation,
	Dialog,
	LiveState,
	ModelInfo,
	PiEvent,
	SessionStateInfo,
	SessionStats,
	Snapshot,
	StreamMessage,
	ThinkingLevel,
	Widget,
} from "../../shared/src/protocol.ts";
import { applyEvent, createConversation } from "../../shared/src/reducer.ts";
import { HttpError } from "./errors.ts";
import type { HandleEvent, SessionHandle } from "./handle.ts";
import { lineSplitter } from "./jsonl.ts";
import { type RpcCommand, toRpc } from "./translate.ts";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

const BOOT_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30 * 60_000;

interface RpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface RpcHandleOptions {
	piBin: string;
	cwd: string;
	sessionFile?: string;
	exportDir: string;
	env?: Record<string, string>;
	promptAckMs?: number; // how long a prompt waits for pi's ack before returning `pending`
}

export class RpcHandle implements SessionHandle {
	readonly kind = "rpc" as const;
	readonly capabilities: Capabilities = { dialogs: "here", fork: true, clone: true, newSession: true, bash: true, export: true };
	readonly cwd: string;
	lastActive = Date.now();

	private opts: RpcHandleOptions;
	private proc: ChildProcessWithoutNullStreams | null = null;
	private pending = new Map<string, (res: RpcResponse) => void>();
	private subscribers = new Set<(m: StreamMessage) => void>();
	private listeners = new Set<(e: HandleEvent) => void>();
	private conv: Conversation = createConversation();
	private state: SessionStateInfo | null = null;
	private stats: SessionStats | null = null;
	private models: ModelInfo[] = [];
	private commands: CommandInfo[] = [];
	private thinkingLevels: ThinkingLevel[] = [];
	private statuses: Record<string, string> = {};
	private widgets: Record<string, Widget> = {};
	private dialogs = new Map<string, Dialog>();
	private stderr = "";
	private closing = false;
	private exited = false;
	private resyncOnSettle = false;

	private constructor(opts: RpcHandleOptions) {
		this.opts = opts;
		this.cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir();
	}

	static async start(opts: RpcHandleOptions): Promise<RpcHandle> {
		const h = new RpcHandle(opts);
		try {
			await h.boot();
		} catch (err) {
			h.close();
			throw new HttpError(502, `Couldn't start pi (${opts.piBin}): ${h.stderrTail() || (err as Error).message}`);
		}
		return h;
	}

	get sessionId(): string {
		return this.state?.sessionId ?? "";
	}
	get sessionFile(): string | null {
		return this.state?.sessionFile ?? this.opts.sessionFile ?? null;
	}
	get pid(): number {
		return this.proc?.pid ?? -1;
	}

	subscriberCount(): number {
		return this.subscribers.size;
	}
	isBusy(): boolean {
		return this.conv.streaming || this.conv.compacting || this.dialogs.size > 0;
	}
	liveState(): LiveState {
		if (this.dialogs.size > 0) return "needs_you";
		return this.conv.streaming || this.conv.compacting ? "running" : "idle";
	}

	snapshot(): Snapshot {
		return {
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			cwd: this.cwd,
			handleKind: "rpc",
			capabilities: this.capabilities,
			conv: this.conv,
			state: this.state as SessionStateInfo,
			stats: this.stats,
			models: this.models,
			thinkingLevels: this.thinkingLevels,
			commands: this.commands,
			dialogs: [...this.dialogs.values()],
			statuses: this.statuses,
			widgets: this.widgets,
		};
	}

	subscribe(fn: (m: StreamMessage) => void): () => void {
		this.subscribers.add(fn);
		this.lastActive = Date.now();
		return () => {
			this.subscribers.delete(fn);
			this.lastActive = Date.now();
		};
	}

	onEvent(fn: (e: HandleEvent) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	close(): void {
		if (this.exited || this.closing) return;
		this.closing = true;
		if (!this.proc) return;
		this.proc.stdin.end();
		setTimeout(() => {
			if (!this.exited) this.proc?.kill("SIGTERM");
		}, 5000).unref();
	}

	async command(cmd: AppCommand): Promise<CommandResult> {
		this.lastActive = Date.now();
		switch (cmd.type) {
			case "attach":
				return { ok: true };
			case "dialog_response": {
				if (!this.dialogs.delete(cmd.id)) return { ok: false, error: "That dialog is no longer open." };
				this.write(toRpc(cmd));
				this.broadcast({ type: "dialog_closed", id: cmd.id });
				this.emit({ type: "state_changed" });
				return { ok: true };
			}
			case "prompt":
				return this.prompt(cmd);
			case "export": {
				mkdirSync(this.opts.exportDir, { recursive: true });
				const name = `${this.sessionId}-${Date.now()}.html`;
				const r = await this.call({ type: "export_html", outputPath: join(this.opts.exportDir, name) });
				return r.success ? { ok: true, data: { name } } : { ok: false, error: r.error ?? "Export failed" };
			}
		}
		const r = await this.call(toRpc(cmd));
		if (!r.success) return { ok: false, error: r.error ?? `${cmd.type} failed` };
		await this.afterCommand(cmd, r.data).catch(() => {});
		return { ok: true, data: r.data };
	}

	stderrTail(lines = 20): string {
		return stripAnsi(this.stderr).trim().split("\n").slice(-lines).join("\n");
	}

	// ---- internals ----------------------------------------------------------

	private async boot(): Promise<void> {
		const args = ["--mode", "rpc"];
		if (this.opts.sessionFile) args.push("--session", this.opts.sessionFile);
		const proc = spawn(this.opts.piBin, args, { cwd: this.cwd, env: { ...process.env, ...this.opts.env, PI_WEB: "1" } });
		this.proc = proc;
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", lineSplitter((line) => this.onRecord(line)));
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (d: string) => {
			this.stderr = (this.stderr + d).slice(-8000);
		});
		proc.stdin.on("error", () => {}); // EPIPE after exit is reported via "exit"
		proc.on("error", (err) => {
			this.stderr += `\n${err.message}`;
			this.onExit(null);
		});
		proc.on("exit", (code) => this.onExit(code));
		await this.refresh({ messages: true, catalog: true }, BOOT_TIMEOUT_MS);
	}

	private write(cmd: RpcCommand): void {
		this.proc?.stdin.write(`${JSON.stringify(cmd)}\n`);
	}

	private call(cmd: RpcCommand, timeoutMs = COMMAND_TIMEOUT_MS): Promise<RpcResponse> {
		if (this.exited || !this.proc) return Promise.resolve({ type: "response", command: cmd.type, success: false, error: "pi is not running" });
		const id = randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ type: "response", command: cmd.type, success: false, error: `${cmd.type} timed out` });
			}, timeoutMs);
			timer.unref();
			this.pending.set(id, (res) => {
				clearTimeout(timer);
				resolve(res);
			});
			this.write({ ...cmd, id });
		});
	}

	private async data<T>(cmd: RpcCommand, timeoutMs?: number): Promise<T> {
		const r = await this.call(cmd, timeoutMs);
		if (!r.success) throw new Error(r.error ?? `${cmd.type} failed`);
		return r.data as T;
	}

	private async refresh(opts: { messages?: boolean; catalog?: boolean } = {}, timeoutMs?: number): Promise<void> {
		const [state, stats, msgs] = await Promise.all([
			this.data<SessionStateInfo>({ type: "get_state" }, timeoutMs),
			this.data<SessionStats>({ type: "get_session_stats" }, timeoutMs).catch(() => null),
			opts.messages ? this.data<{ messages: AgentMessage[] }>({ type: "get_messages" }, timeoutMs) : Promise.resolve(null),
		]);
		this.state = { ...state, model: state.model ? slimModel(state.model) : null };
		this.stats = stats;
		if (msgs) {
			const prev = this.conv;
			this.conv = createConversation(msgs.messages);
			this.conv.streaming = prev.streaming || state.isStreaming;
			this.conv.partial = prev.partial;
			this.conv.tools = prev.tools;
			this.conv.queue = prev.queue;
		}
		if (opts.catalog) {
			const [commands, models, levels] = await Promise.all([
				this.data<{ commands: CommandInfo[] }>({ type: "get_commands" }, timeoutMs).catch(() => ({ commands: [] })),
				this.data<{ models: ModelInfo[] }>({ type: "get_available_models" }, timeoutMs).catch(() => ({ models: [] })),
				this.data<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" }, timeoutMs).catch(() => ({ levels: [] })),
			]);
			this.commands = commands.commands.map(({ name, description, source }) => ({ name, description, source }));
			this.models = models.models.map(slimModel);
			this.thinkingLevels = levels.levels;
		}
	}

	private async prompt(cmd: Extract<AppCommand, { type: "prompt" }>): Promise<CommandResult> {
		const response = this.call(toRpc(cmd));
		let timer: NodeJS.Timeout | undefined;
		const ackWindow = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), this.opts.promptAckMs ?? 3000);
		});
		const first = await Promise.race([response, ackWindow]);
		clearTimeout(timer);
		if (first === null) {
			// pi holds the response while an extension command waits on a dialog.
			response.then((r) => {
				if (!r.success) this.broadcast({ type: "command_error", command: "prompt", error: r.error ?? "Prompt failed" });
			});
			return { ok: true, pending: true };
		}
		return first.success ? { ok: true, data: first.data } : { ok: false, error: first.error ?? "Prompt failed" };
	}

	private async afterCommand(cmd: AppCommand, data: unknown): Promise<void> {
		switch (cmd.type) {
			case "new_session":
			case "fork":
			case "clone": {
				if ((data as { cancelled?: boolean } | undefined)?.cancelled) return;
				const before = this.sessionId;
				await this.refresh({ messages: true, catalog: true });
				this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
				if (this.sessionId !== before) this.emit({ type: "session_changed", from: before, to: this.sessionId });
				return;
			}
			case "compact":
			case "bash":
				await this.refresh({ messages: true });
				this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
				return;
			case "set_model":
			case "set_thinking":
				await this.refresh({ catalog: true });
				this.broadcast(this.meta());
				return;
			case "rename":
				await this.refresh();
				this.broadcast(this.meta());
				this.emit({ type: "renamed" });
				return;
		}
	}

	private onRecord(line: string): void {
		let rec: PiEvent;
		try {
			rec = JSON.parse(line);
		} catch {
			return;
		}
		if (rec.type === "response") {
			const done = rec.id ? this.pending.get(rec.id) : undefined;
			if (done) {
				this.pending.delete(rec.id);
				done(rec as RpcResponse);
			}
			return;
		}
		this.lastActive = Date.now();
		if (rec.type === "extension_ui_request") return this.onUiRequest(rec);

		const before = this.liveState();
		applyEvent(this.conv, rec);
		this.broadcast({ type: "event", event: rec });
		switch (rec.type) {
			case "turn_end":
				this.refresh()
					.then(() => this.broadcast(this.meta()))
					.catch(() => {});
				break;
			case "agent_settled": {
				const resync = this.resyncOnSettle;
				this.resyncOnSettle = false;
				this.refresh({ messages: resync })
					.then(() => this.broadcast(resync ? { type: "snapshot", snapshot: this.snapshot() } : this.meta()))
					.catch(() => {});
				break;
			}
			case "compaction_end":
				if (this.conv.streaming) this.resyncOnSettle = true;
				else
					this.refresh({ messages: true })
						.then(() => this.broadcast({ type: "snapshot", snapshot: this.snapshot() }))
						.catch(() => {});
				break;
			case "session_info_changed":
				this.refresh()
					.then(() => {
						this.broadcast(this.meta());
						this.emit({ type: "renamed" });
					})
					.catch(() => {});
				break;
			case "thinking_level_changed":
				this.refresh()
					.then(() => this.broadcast(this.meta()))
					.catch(() => {});
				break;
		}
		if (this.liveState() !== before) this.emit({ type: "state_changed" });
	}

	private onUiRequest(req: PiEvent): void {
		switch (req.method) {
			case "setStatus":
				if (req.statusText) this.statuses[req.statusKey] = stripAnsi(String(req.statusText));
				else delete this.statuses[req.statusKey];
				this.broadcast(this.meta());
				return;
			case "setWidget":
				if (Array.isArray(req.widgetLines) && req.widgetLines.length > 0)
					this.widgets[req.widgetKey] = { lines: req.widgetLines.map((l: string) => stripAnsi(String(l))), placement: req.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor" };
				else delete this.widgets[req.widgetKey];
				this.broadcast(this.meta());
				return;
			case "notify":
				this.broadcast({ type: "notify", message: stripAnsi(String(req.message ?? "")), level: req.notifyType === "warning" || req.notifyType === "error" ? req.notifyType : "info" });
				return;
			case "set_editor_text":
				this.broadcast({ type: "editor_text", text: String(req.text ?? "") });
				return;
			case "select":
			case "confirm":
			case "input":
			case "editor": {
				const dialog: Dialog = {
					id: req.id,
					method: req.method,
					title: stripAnsi(String(req.title ?? "")),
					message: req.message ? stripAnsi(String(req.message)) : undefined,
					options: req.options,
					placeholder: req.placeholder,
					prefill: req.prefill,
					timeout: req.timeout,
				};
				this.dialogs.set(dialog.id, dialog);
				if (dialog.timeout) {
					setTimeout(() => {
						if (!this.dialogs.delete(dialog.id)) return;
						this.broadcast({ type: "dialog_closed", id: dialog.id });
						this.emit({ type: "state_changed" });
					}, dialog.timeout).unref();
				}
				this.broadcast({ type: "dialog", dialog });
				this.emit({ type: "state_changed" });
				return;
			}
			default:
				return; // setTitle and anything newer: nothing to show
		}
	}

	private meta(): StreamMessage {
		return { type: "meta", state: this.state as SessionStateInfo, stats: this.stats, statuses: this.statuses, widgets: this.widgets, thinkingLevels: this.thinkingLevels };
	}

	private onExit(code: number | null): void {
		if (this.exited) return;
		this.exited = true;
		for (const resolve of this.pending.values()) resolve({ type: "response", command: "", success: false, error: "pi exited" });
		this.pending.clear();
		const stderr = this.stderrTail();
		this.broadcast(this.closing ? { type: "handle_gone", reason: "closed" } : { type: "handle_gone", reason: "exit", stderr });
		this.emit({ type: "exit", code, stderr, closedByHub: this.closing });
	}

	private broadcast(m: StreamMessage): void {
		for (const fn of this.subscribers) fn(m);
	}

	private emit(e: HandleEvent): void {
		for (const fn of this.listeners) fn(e);
	}
}

function slimModel(m: ModelInfo): ModelInfo {
	return { id: m.id, name: m.name, provider: m.provider, reasoning: m.reasoning, input: m.input, contextWindow: m.contextWindow, maxTokens: m.maxTokens, cost: m.cost };
}
```

- [ ] **Step 6: Run the tests and typecheck to verify they pass**

Run: `npm test -w hub && npm run typecheck -w hub`
Expected: every RpcHandle test passes (each one starts a real pi, so allow about a minute), and tsc exits 0.

If "fork moves the handle" fails because pi's `fork` keeps the same session id, record pi's actual behavior in a comment on the test. Then change the assertion to match it (a snapshot with the forked history), and keep `session_changed` firing only when the id really changes.

- [ ] **Step 7: Commit**

```bash
git add hub
git commit -m "feat(hub): RpcHandle runs a headless pi per session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: Registry: start on demand, re-key, cap, idle cleanup

**Files:**
- Create: `hub/src/registry.ts`, `hub/test/support/fake-handle.ts`
- Test: `hub/test/registry.test.ts`

**Interfaces:**
- Consumes: `SessionHandle` and `HandleEvent` (Task 5), and `HttpError` (Task 2).
- Produces:
  - `class Registry`, with:
    - `constructor(opts: RegistryOptions)`
    - `get(id): SessionHandle | undefined`
    - `all(): SessionHandle[]` (unique handles)
    - `info(id): LiveInfo`
    - `lastError(id): string | undefined`
    - `onChange(fn: (m: ListMessage) => void): () => void`
    - `ensure(id): Promise<SessionHandle>`
    - `create(cwd): Promise<SessionHandle>`
    - `close(id): void`
    - `closeAll(): void`
    - `reap(): void`
  - `RegistryOptions = { factory: HandleFactory; lookup: SessionLookup; maxHeadless: number; idleMs: number; now?: () => number }`
  - `HandleFactory = { startRpc(opts: { cwd: string; sessionFile?: string }): Promise<SessionHandle> }`
  - `SessionLookup = { find(id: string): Promise<{ cwd: string; file: string } | null> }`
  - `LiveInfo = { live: boolean; handleKind: HandleKind | null; state: LiveState }`
  - `class FakeHandle implements SessionHandle` (test support), with public `sessionId`, `busy`, `state`, `closed`, `received: AppCommand[]`, `conv`, `push(m: StreamMessage)`, `fire(e: HandleEvent)`

- [ ] **Step 1: Write the FakeHandle test double**

`hub/test/support/fake-handle.ts`:

```ts
import type { AppCommand, Capabilities, CommandResult, LiveState, Snapshot, StreamMessage } from "../../../shared/src/protocol.ts";
import { createConversation } from "../../../shared/src/reducer.ts";
import type { HandleEvent, SessionHandle } from "../../src/handle.ts";

export class FakeHandle implements SessionHandle {
	readonly kind = "rpc" as const;
	readonly capabilities: Capabilities = { dialogs: "here", fork: true, clone: true, newSession: true, bash: true, export: true };
	readonly pid = 4242;
	readonly cwd: string;
	readonly sessionFile: string | null;
	sessionId: string;
	lastActive = 0;
	busy = false;
	state: LiveState = "idle";
	closed = false;
	received: AppCommand[] = [];
	conv = createConversation();
	private subs = new Set<(m: StreamMessage) => void>();
	private listeners = new Set<(e: HandleEvent) => void>();

	constructor(sessionId: string, cwd = "/tmp", sessionFile: string | null = null) {
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.sessionFile = sessionFile;
	}

	subscriberCount(): number {
		return this.subs.size;
	}
	isBusy(): boolean {
		return this.busy;
	}
	liveState(): LiveState {
		return this.state;
	}
	snapshot(): Snapshot {
		return {
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			cwd: this.cwd,
			handleKind: "rpc",
			capabilities: this.capabilities,
			conv: this.conv,
			state: { model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, sessionId: this.sessionId, messageCount: 0, pendingMessageCount: 0, autoCompactionEnabled: true },
			stats: null,
			models: [],
			thinkingLevels: ["off"],
			commands: [],
			dialogs: [],
			statuses: {},
			widgets: {},
		};
	}
	async command(cmd: AppCommand): Promise<CommandResult> {
		this.received.push(cmd);
		return { ok: true };
	}
	subscribe(fn: (m: StreamMessage) => void): () => void {
		this.subs.add(fn);
		return () => {
			this.subs.delete(fn);
		};
	}
	onEvent(fn: (e: HandleEvent) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}
	push(m: StreamMessage): void {
		for (const fn of this.subs) fn(m);
	}
	fire(e: HandleEvent): void {
		for (const fn of this.listeners) fn(e);
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.push({ type: "handle_gone", reason: "closed" });
		this.fire({ type: "exit", code: 0, stderr: "", closedByHub: true });
	}
}
```

- [ ] **Step 2: Write the failing registry tests**

`hub/test/registry.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ListMessage } from "../../shared/src/protocol.ts";
import { HttpError } from "../src/errors.ts";
import { Registry, type RegistryOptions } from "../src/registry.ts";
import { FakeHandle } from "./support/fake-handle.ts";

function setup(opts: Partial<RegistryOptions> = {}) {
	const files: Record<string, { cwd: string; file: string }> = {
		"disk-1": { cwd: "/w", file: "/s/disk-1.jsonl" },
		"disk-2": { cwd: "/w", file: "/s/disk-2.jsonl" },
	};
	const started: FakeHandle[] = [];
	let n = 0;
	let clock = 0;
	const changes: ListMessage[] = [];
	const registry = new Registry({
		factory: {
			async startRpc(o) {
				await sleep(5);
				const id = o.sessionFile ? o.sessionFile.replace(/^.*\/|\.jsonl$/g, "") : `new-${++n}`;
				const h = new FakeHandle(id, o.cwd, o.sessionFile ?? null);
				started.push(h);
				return h;
			},
		},
		lookup: { find: async (id) => files[id] ?? null },
		maxHeadless: 6,
		idleMs: 1000,
		now: () => clock,
		...opts,
	});
	registry.onChange((m) => changes.push(m));
	return { registry, started, changes, setClock: (t: number) => (clock = t) };
}

test("concurrent ensure() starts one process per session", async () => {
	const { registry, started } = setup();
	const [a, b] = await Promise.all([registry.ensure("disk-1"), registry.ensure("disk-1")]);
	assert.equal(a, b);
	assert.equal(started.length, 1);
	assert.deepEqual(registry.info("disk-1"), { live: true, handleKind: "rpc", state: "idle" });
	assert.equal(await registry.ensure("disk-1"), a);
});

test("ensure() of an unknown session is a 404", async () => {
	const { registry } = setup();
	await assert.rejects(registry.ensure("nope"), (e: unknown) => e instanceof HttpError && e.status === 404);
});

test("create() registers the new session and announces it", async () => {
	const { registry, changes } = setup();
	const h = await registry.create("/w");
	assert.equal(registry.get(h.sessionId), h);
	assert.ok(changes.some((m) => m.type === "session_state" && m.sessionId === h.sessionId && m.live));
});

test("at the cap, the least recently used idle session is closed; if none is idle, 503", async () => {
	const { registry, started } = setup({ maxHeadless: 2 });
	await registry.ensure("disk-1");
	await registry.ensure("disk-2");
	started[0].lastActive = 1;
	started[1].lastActive = 2;
	await registry.create("/w");
	assert.equal(started[0].closed, true);
	assert.equal(started[1].closed, false);
	assert.equal(registry.get("disk-1"), undefined);
	for (const h of started) h.busy = true;
	await assert.rejects(registry.create("/w"), (e: unknown) => e instanceof HttpError && e.status === 503);
});

test("reap() closes only idle, unwatched sessions past the idle timeout", async () => {
	const { registry, started, setClock } = setup();
	const [idle, busy, watched] = await Promise.all([registry.ensure("disk-1"), registry.ensure("disk-2"), registry.create("/w")]);
	for (const h of started) h.lastActive = 0;
	(busy as FakeHandle).busy = true;
	const unsubscribe = watched.subscribe(() => {});
	setClock(500);
	registry.reap();
	assert.equal((idle as FakeHandle).closed, false);
	setClock(2000);
	registry.reap();
	assert.equal((idle as FakeHandle).closed, true);
	assert.equal((busy as FakeHandle).closed, false);
	assert.equal((watched as FakeHandle).closed, false);
	unsubscribe();
});

test("a session change inside a handle re-keys it", async () => {
	const { registry, changes } = setup();
	const h = (await registry.ensure("disk-1")) as FakeHandle;
	h.sessionId = "forked";
	h.fire({ type: "session_changed", from: "disk-1", to: "forked" });
	assert.equal(registry.get("forked"), h);
	assert.equal(registry.get("disk-1"), undefined);
	assert.ok(changes.some((m) => m.type === "session_list_changed"));
});

test("an unexpected exit marks the session as errored until it is started again", async () => {
	const { registry } = setup();
	const h = (await registry.ensure("disk-1")) as FakeHandle;
	h.fire({ type: "exit", code: 1, stderr: "extension crashed", closedByHub: false });
	assert.deepEqual(registry.info("disk-1"), { live: false, handleKind: null, state: "error" });
	assert.equal(registry.lastError("disk-1"), "extension crashed");
	await registry.ensure("disk-1");
	assert.equal(registry.info("disk-1").state, "idle");
	assert.equal(registry.lastError("disk-1"), undefined);
});

test("state changes from a handle are announced", async () => {
	const { registry, changes } = setup();
	const h = (await registry.ensure("disk-1")) as FakeHandle;
	h.state = "needs_you";
	h.fire({ type: "state_changed" });
	assert.deepEqual(changes.at(-1), { type: "session_state", sessionId: "disk-1", live: true, handleKind: "rpc", state: "needs_you" });
});

test("close() and closeAll() stop headless sessions", async () => {
	const { registry, started } = setup();
	await registry.ensure("disk-1");
	await registry.ensure("disk-2");
	registry.close("disk-1");
	assert.equal(started[0].closed, true);
	registry.closeAll();
	assert.equal(started[1].closed, true);
	assert.deepEqual(registry.all(), []);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w hub -- --test-name-pattern="ensure|create|cap|reap|re-keys|exit marks|announced|closeAll"`
Expected: FAIL, because `registry.ts` doesn't exist.

- [ ] **Step 4: Implement the registry**

`hub/src/registry.ts`:

```ts
// Which pi process (if any) is serving each session. Starts headless pi on
// demand, follows sessions that move (fork/clone/new), keeps at most
// maxHeadless running, and closes idle ones (spec §3.2).

import type { HandleKind, ListMessage, LiveState } from "../../shared/src/protocol.ts";
import { HttpError } from "./errors.ts";
import type { SessionHandle } from "./handle.ts";

export interface HandleFactory {
	startRpc(opts: { cwd: string; sessionFile?: string }): Promise<SessionHandle>;
}

export interface SessionLookup {
	find(id: string): Promise<{ cwd: string; file: string } | null>;
}

export interface RegistryOptions {
	factory: HandleFactory;
	lookup: SessionLookup;
	maxHeadless: number;
	idleMs: number;
	now?: () => number;
}

export interface LiveInfo {
	live: boolean;
	handleKind: HandleKind | null;
	state: LiveState;
}

export class Registry {
	private opts: RegistryOptions;
	private handles = new Map<string, SessionHandle>();
	private starting = new Map<string, Promise<SessionHandle>>();
	private errors = new Map<string, string>();
	private listeners = new Set<(m: ListMessage) => void>();

	constructor(opts: RegistryOptions) {
		this.opts = opts;
	}

	get(id: string): SessionHandle | undefined {
		return this.handles.get(id);
	}

	all(): SessionHandle[] {
		return [...new Set(this.handles.values())];
	}

	info(id: string): LiveInfo {
		const h = this.handles.get(id);
		if (h) return { live: true, handleKind: h.kind, state: h.liveState() };
		return { live: false, handleKind: null, state: this.errors.has(id) ? "error" : "idle" };
	}

	lastError(id: string): string | undefined {
		return this.errors.get(id);
	}

	onChange(fn: (m: ListMessage) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	async ensure(id: string): Promise<SessionHandle> {
		const live = this.handles.get(id);
		if (live) return live;
		const inFlight = this.starting.get(id);
		if (inFlight) return inFlight;
		const p = (async () => {
			const found = await this.opts.lookup.find(id);
			if (!found) throw new HttpError(404, "Session not found");
			return this.launch({ cwd: found.cwd, sessionFile: found.file });
		})();
		this.starting.set(id, p);
		try {
			return await p;
		} finally {
			this.starting.delete(id);
		}
	}

	create(cwd: string): Promise<SessionHandle> {
		return this.launch({ cwd });
	}

	close(id: string): void {
		const h = this.handles.get(id);
		if (h?.kind === "rpc") h.close();
	}

	closeAll(): void {
		for (const h of this.all()) if (h.kind === "rpc") h.close();
	}

	reap(): void {
		const now = (this.opts.now ?? Date.now)();
		for (const h of this.all()) {
			if (h.kind === "rpc" && this.isIdle(h) && now - h.lastActive > this.opts.idleMs) {
				this.forget(h);
				h.close();
			}
		}
	}

	private isIdle(h: SessionHandle): boolean {
		return h.subscriberCount() === 0 && !h.isBusy();
	}

	private async launch(o: { cwd: string; sessionFile?: string }): Promise<SessionHandle> {
		this.makeRoom();
		const h = await this.opts.factory.startRpc(o);
		this.adopt(h);
		return h;
	}

	private makeRoom(): void {
		const headless = this.all().filter((h) => h.kind === "rpc");
		if (headless.length < this.opts.maxHeadless) return;
		const victim = headless.filter((h) => this.isIdle(h)).sort((a, b) => a.lastActive - b.lastActive)[0];
		if (!victim) throw new HttpError(503, `${this.opts.maxHeadless} pi sessions are already running. Close one first.`);
		this.forget(victim);
		victim.close();
	}

	private adopt(h: SessionHandle): void {
		this.errors.delete(h.sessionId);
		this.handles.set(h.sessionId, h);
		h.onEvent((e) => {
			switch (e.type) {
				case "state_changed":
					this.emitState(h.sessionId);
					break;
				case "renamed":
					this.emit({ type: "session_list_changed" });
					break;
				case "session_changed":
					if (this.handles.get(e.from) === h) this.handles.delete(e.from);
					this.handles.set(e.to, h);
					this.emitState(e.from);
					this.emitState(e.to);
					this.emit({ type: "session_list_changed" });
					break;
				case "exit":
					this.forget(h);
					if (!e.closedByHub && e.code !== 0) {
						this.errors.set(h.sessionId, e.stderr || `pi exited with code ${e.code}`);
						this.emitState(h.sessionId);
					}
					break;
			}
		});
		this.emitState(h.sessionId);
	}

	private forget(h: SessionHandle): void {
		for (const [id, x] of [...this.handles]) {
			if (x !== h) continue;
			this.handles.delete(id);
			this.emitState(id);
		}
	}

	private emitState(id: string): void {
		this.emit({ type: "session_state", sessionId: id, ...this.info(id) });
	}

	private emit(m: ListMessage): void {
		for (const fn of this.listeners) fn(m);
	}
}
```

- [ ] **Step 5: Run the tests and typecheck to verify they pass**

Run: `npm test -w hub && npm run typecheck -w hub`
Expected: all tests pass and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add hub
git commit -m "feat(hub): session registry with on-demand start, re-keying, cap and idle cleanup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: HTTP server: routes, CORS, SSE

**Files:**
- Create: `hub/src/server.ts`, `hub/test/support/http.ts`
- Test: `hub/test/server.test.ts`

**Interfaces:**
- Consumes: `checkRequest`/`corsHeaders` (Task 2), `SessionIndex`/`readHistory`/`knownCwds` (Task 3), `Registry` (Task 6), and `FakeHandle` (Task 6).
- Produces: `createHubServer(deps: HubDeps): http.Server`, where `HubDeps = { cfg: HubConfig; registry: Registry; index: SessionIndex; version: string; home?: string; log?: (msg: string) => void }`. The routes are exactly those in spec §2.3, minus push (Plan 3).
  - `GET /api/sessions/:id/history` returns `{ messages, live, cwd, name?, error? }`.
  - `POST /api/sessions/:id/commands` returns `{ result: CommandResult, sessionId }`.
  - The `stream` endpoint sends `detached` when no handle is running, and attaches automatically once one starts.

- [ ] **Step 1: Write the HTTP test helpers**

`hub/test/support/http.ts`:

```ts
import { type IncomingHttpHeaders, request } from "node:http";

export interface Resp {
	status: number;
	headers: IncomingHttpHeaders;
	body: any;
}

const clean = (h: Record<string, string | undefined>) => Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)) as Record<string, string>;

export function call(port: number, method: string, path: string, headers: Record<string, string | undefined>, body?: unknown): Promise<Resp> {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const req = request({ host: "127.0.0.1", port, method, path, headers: clean({ ...headers, "content-type": data ? "application/json" : undefined }) }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (text += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? JSON.parse(text) : null }));
		});
		req.on("error", reject);
		req.end(data);
	});
}

export interface SseClient {
	messages: unknown[];
	next(pred: (m: { type?: string; [k: string]: unknown }) => boolean, timeoutMs?: number): Promise<{ type?: string; [k: string]: unknown }>;
	close(): void;
}

export function openSse(port: number, path: string, headers: Record<string, string | undefined>): Promise<SseClient> {
	return new Promise((resolve, reject) => {
		const messages: Array<{ type?: string }> = [];
		const waiters: Array<{ pred: (m: { type?: string }) => boolean; resolve: (m: { type?: string }) => void }> = [];
		const req = request({ host: "127.0.0.1", port, path, headers: clean(headers) }, (res) => {
			if (res.statusCode !== 200) return reject(new Error(`SSE status ${res.statusCode}`));
			let buf = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				buf += chunk;
				let i = buf.indexOf("\n\n");
				while (i !== -1) {
					const frame = buf.slice(0, i);
					buf = buf.slice(i + 2);
					for (const line of frame.split("\n")) {
						if (!line.startsWith("data: ")) continue;
						const msg = JSON.parse(line.slice(6));
						messages.push(msg);
						for (const w of [...waiters]) {
							if (!w.pred(msg)) continue;
							waiters.splice(waiters.indexOf(w), 1);
							w.resolve(msg);
						}
					}
					i = buf.indexOf("\n\n");
				}
			});
			resolve({
				messages,
				next(pred, timeoutMs = 5000) {
					const hit = messages.find((m) => pred(m));
					if (hit) {
						messages.splice(messages.indexOf(hit), 1);
						return Promise.resolve(hit);
					}
					return new Promise((res2, rej2) => {
						const timer = setTimeout(() => rej2(new Error("timed out waiting for SSE message")), timeoutMs);
						waiters.push({ pred, resolve: (m) => (clearTimeout(timer), messages.splice(messages.indexOf(m), 1), res2(m)) });
					});
				},
				close: () => req.destroy(),
			});
		});
		req.on("error", (e) => (e.message === "socket hang up" ? undefined : reject(e)));
		req.end();
	});
}
```

- [ ] **Step 2: Write the failing server tests**

`hub/test/server.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { applyEvent } from "../../shared/src/reducer.ts";
import type { HubConfig } from "../src/config.ts";
import { Registry } from "../src/registry.ts";
import { createHubServer } from "../src/server.ts";
import { SessionIndex } from "../src/sessions.ts";
import { FakeHandle } from "./support/fake-handle.ts";
import { call, openSse } from "./support/http.ts";

const root = mkdtempSync(join(tmpdir(), "pi-web-server-"));
const work = join(root, "work");
const sessions = join(root, "sessions");
mkdirSync(work);
mkdirSync(join(sessions, "--work--"), { recursive: true });
writeFileSync(
	join(sessions, "--work--", "2026-10-07T00-00-00-000Z_disk-1.jsonl"),
	`${JSON.stringify({ type: "session", version: 3, id: "disk-1", timestamp: "2026-10-07T00:00:00.000Z", cwd: work })}\n` +
		`${JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "x", message: { role: "user", content: "from the cli", timestamp: 1 } })}\n`,
);

const cfg: HubConfig = {
	port: 0,
	hostname: "hub.test:7878",
	allowedLogin: "me@github",
	allowedOrigins: ["https://pi.thatsit.dev"],
	idleMinutes: 20,
	maxHeadless: 6,
	piBin: "pi",
	dev: false,
	dataDir: root,
};
const GOOD = { origin: "https://pi.thatsit.dev", host: "hub.test:7878", "tailscale-user-login": "me@github" };

const handles = new Map<string, FakeHandle>();
let n = 0;
const index = new SessionIndex(sessions);
const registry = new Registry({
	factory: {
		async startRpc(o) {
			const id = o.sessionFile ? "disk-1" : `new-${++n}`;
			const h = new FakeHandle(id, o.cwd, o.sessionFile ?? null);
			handles.set(id, h);
			return h;
		},
	},
	lookup: index,
	maxHeadless: 6,
	idleMs: 60_000,
});
const logs: string[] = [];
const server = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: work, log: (m) => logs.push(m) });
let port = 0;
before(async () => {
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as AddressInfo).port;
});
after(() => {
	server.closeAllConnections();
	server.close();
});

test("rejects requests from other origins or without the tailnet identity", async () => {
	assert.equal((await call(port, "GET", "/api/sessions", { ...GOOD, origin: "https://evil.example" })).status, 403);
	assert.equal((await call(port, "GET", "/api/sessions", { ...GOOD, "tailscale-user-login": undefined })).status, 403);
	assert.equal((await call(port, "GET", "/api/sessions", { ...GOOD, host: "evil.example" })).status, 403);
	assert.ok(logs.some((l) => l.includes("origin https://evil.example")));
});

test("answers CORS preflight only for the app's origin", async () => {
	const ok = await call(port, "OPTIONS", "/api/sessions", { origin: "https://pi.thatsit.dev", host: "hub.test:7878" });
	assert.equal(ok.status, 204);
	assert.equal(ok.headers["access-control-allow-origin"], "https://pi.thatsit.dev");
	assert.equal((await call(port, "OPTIONS", "/api/sessions", { origin: "https://evil.example" })).status, 403);
});

test("health reports the caller's login and the hub version", async () => {
	const r = await call(port, "GET", "/api/health", GOOD);
	assert.equal(r.status, 200);
	assert.deepEqual(r.body, { ok: true, login: "me@github", hubVersion: "0.1.0-test", vapidPublicKey: null });
	assert.equal(r.headers["access-control-allow-origin"], "https://pi.thatsit.dev");
});

test("lists sessions from disk and new live sessions without files", async () => {
	let r = await call(port, "GET", "/api/sessions", GOOD);
	const disk = r.body.sessions.find((s: { id: string }) => s.id === "disk-1");
	assert.equal(disk.firstPrompt, "from the cli");
	assert.equal(disk.live, false);
	assert.equal(disk.file, undefined, "file paths stay on the hub");
	const created = await call(port, "POST", "/api/sessions", GOOD, { cwd: work });
	assert.equal(created.status, 200);
	r = await call(port, "GET", "/api/sessions", GOOD);
	const fresh = r.body.sessions.find((s: { id: string }) => s.id === created.body.sessionId);
	assert.equal(fresh.live, true);
	assert.equal(fresh.cwd, work);
});

test("new sessions need an existing folder; ~ expands to home", async () => {
	const bad = await call(port, "POST", "/api/sessions", GOOD, { cwd: join(root, "missing") });
	assert.equal(bad.status, 400);
	assert.match(bad.body.error, /Not a folder/);
	const home = await call(port, "POST", "/api/sessions", GOOD, { cwd: "~" });
	assert.equal(home.status, 200);
	assert.equal(handles.get(home.body.sessionId)?.cwd, work);
});

test("commands: validated, 404 for unknown sessions, forwarded to the session's handle", async () => {
	assert.equal((await call(port, "POST", "/api/sessions/disk-1/commands", GOOD, { type: "rm_rf" })).status, 400);
	assert.equal((await call(port, "POST", "/api/sessions/nope/commands", GOOD, { type: "attach" })).status, 404);
	const r = await call(port, "POST", "/api/sessions/disk-1/commands", GOOD, { type: "prompt", text: "hi", mode: "send" });
	assert.deepEqual(r.body, { result: { ok: true }, sessionId: "disk-1" });
	assert.deepEqual(handles.get("disk-1")?.received.at(-1), { type: "prompt", text: "hi", mode: "send" });
});

test("history reads the file when no process is running", async () => {
	registry.close("disk-1");
	const r = await call(port, "GET", "/api/sessions/disk-1/history", GOOD);
	assert.equal(r.body.live, false);
	assert.equal(r.body.messages[0].content, "from the cli");
	assert.equal((await call(port, "GET", "/api/sessions/nope/history", GOOD)).status, 404);
});

test("a stream waits detached, then attaches when the session starts", async () => {
	registry.close("disk-1");
	const sse = await openSse(port, "/api/sessions/disk-1/stream", GOOD);
	assert.equal((await sse.next((m) => m.type !== undefined)).type, "detached");
	await call(port, "POST", "/api/sessions/disk-1/commands", GOOD, { type: "attach" });
	const snap = await sse.next((m) => m.type === "snapshot");
	assert.equal((snap.snapshot as { sessionId: string }).sessionId, "disk-1");
	handles.get("disk-1")?.push({ type: "notify", message: "hello", level: "info" });
	assert.equal((await sse.next((m) => m.type === "notify")).message, "hello");
	handles.get("disk-1")?.close();
	await sse.next((m) => m.type === "handle_gone");
	await sse.next((m) => m.type === "detached");
	sse.close();
});

test("reconnecting mid-reply gets the partial message in the snapshot", async () => {
	await call(port, "POST", "/api/sessions/disk-1/commands", GOOD, { type: "attach" });
	const h = handles.get("disk-1") as FakeHandle;
	applyEvent(h.conv, { type: "agent_start" });
	applyEvent(h.conv, { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } });
	applyEvent(h.conv, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
	const sse = await openSse(port, "/api/sessions/disk-1/stream", GOOD);
	const snap = await sse.next((m) => m.type === "snapshot");
	const conv = (snap.snapshot as { conv: { streaming: boolean; partial: { content: Array<{ text: string }> } } }).conv;
	assert.equal(conv.streaming, true);
	assert.equal(conv.partial.content[0].text, "Hel");
	sse.close();
});

test("the events stream relays session state changes", async () => {
	const sse = await openSse(port, "/api/events", GOOD);
	const created = await call(port, "POST", "/api/sessions", GOOD, { cwd: work });
	const m = await sse.next((x) => x.type === "session_state" && x.sessionId === created.body.sessionId);
	assert.equal(m.live, true);
	sse.close();
});

test("unknown routes are 404 JSON", async () => {
	const r = await call(port, "GET", "/api/nope", GOOD);
	assert.equal(r.status, 404);
	assert.equal(r.body.error, "Not found");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w hub -- --test-name-pattern="rejects requests|preflight|health|lists sessions|new sessions need|commands:|history reads|stream waits|reconnecting|events stream|unknown routes"`
Expected: FAIL, because `server.ts` doesn't exist.

- [ ] **Step 4: Implement the server**

`hub/src/server.ts`:

```ts
// HTTP API for the PWA (spec §2.3). Every request passes checkRequest except
// CORS preflights from an allowed origin. Streams are Server-Sent Events.

import { createReadStream, existsSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_COMMAND_TYPES, type AppCommand, type HealthInfo, type ListMessage, type SessionSummary, type StreamMessage } from "../../shared/src/protocol.ts";
import { checkRequest, corsHeaders } from "./auth.ts";
import type { HubConfig } from "./config.ts";
import { HttpError } from "./errors.ts";
import type { SessionHandle } from "./handle.ts";
import type { Registry } from "./registry.ts";
import { type SessionIndex, knownCwds, readHistory } from "./sessions.ts";

export interface HubDeps {
	cfg: HubConfig;
	registry: Registry;
	index: SessionIndex;
	version: string;
	home?: string;
	log?: (msg: string) => void;
}

type Cors = Record<string, string>;
const MAX_BODY = 50 * 1024 * 1024; // prompts can carry images
const SSE_PING_MS = 20_000;

export function createHubServer(deps: HubDeps): Server {
	const home = deps.home ?? homedir();
	const log = deps.log ?? ((m: string) => console.log(m));
	const { cfg, registry, index } = deps;

	async function route(req: IncomingMessage, res: ServerResponse, cors: Cors): Promise<void> {
		const { pathname: p } = new URL(req.url ?? "/", "http://hub");
		const m = req.method;

		if (m === "GET" && p === "/api/health") {
			const body: HealthInfo = { ok: true, login: String(req.headers["tailscale-user-login"]), hubVersion: deps.version, vapidPublicKey: null };
			return sendJson(res, 200, body, cors);
		}
		if (m === "GET" && p === "/api/sessions") return sendJson(res, 200, { sessions: await listSessions(), home }, cors);
		if (m === "GET" && p === "/api/cwds") return sendJson(res, 200, { cwds: knownCwds(await index.list(), home), home }, cors);
		if (m === "GET" && p === "/api/events") return listStream(req, res, cors);
		if (m === "POST" && p === "/api/sessions") {
			const body = (await readJson(req)) as { cwd?: unknown };
			const cwd = (typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : home).replace(/^~(?=\/|$)/, home);
			if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new HttpError(400, `Not a folder: ${cwd}`);
			const h = await registry.create(cwd);
			return sendJson(res, 200, { sessionId: h.sessionId }, cors);
		}

		const sm = p.match(/^\/api\/sessions\/([\w.-]+)\/(history|stream|commands|close)$/);
		if (sm) {
			const [, id, action] = sm;
			if (m === "GET" && action === "history") return sendJson(res, 200, await history(id), cors);
			if (m === "GET" && action === "stream") return sessionStream(req, res, cors, id);
			if (m === "POST" && action === "commands") {
				const cmd = parseCommand(await readJson(req));
				const h = await registry.ensure(id);
				const result = await h.command(cmd);
				return sendJson(res, 200, { result, sessionId: h.sessionId }, cors);
			}
			if (m === "POST" && action === "close") {
				registry.close(id);
				return sendJson(res, 200, { ok: true }, cors);
			}
		}

		const ex = p.match(/^\/api\/exports\/([\w.-]+\.html)$/);
		if (m === "GET" && ex) {
			const file = join(cfg.dataDir, "exports", ex[1]);
			if (!existsSync(file)) throw new HttpError(404, "Export not found");
			res.writeHead(200, { ...cors, "content-type": "text/html; charset=utf-8", "content-disposition": `attachment; filename="${ex[1]}"` });
			createReadStream(file).pipe(res);
			return;
		}
		throw new HttpError(404, "Not found");
	}

	async function listSessions(): Promise<SessionSummary[]> {
		const files = await index.list();
		const known = new Set(files.map((f) => f.id));
		const now = Date.now();
		// A brand-new session has no file until its first message.
		const fresh = registry
			.all()
			.filter((h) => h.sessionId && !known.has(h.sessionId))
			.map((h) => ({ id: h.sessionId, cwd: h.cwd, name: h.snapshot().state?.sessionName ?? null, firstPrompt: null, userMessages: 0, model: null, contextTokens: null, createdAt: now, updatedAt: now, parentSession: null }));
		const onDisk = files.map(({ file: _file, ...s }) => s);
		return [...fresh, ...onDisk].map((s) => ({ ...s, ...registry.info(s.id) }));
	}

	async function history(id: string) {
		const h = registry.get(id);
		if (h) return { messages: h.snapshot().conv.messages, live: true, cwd: h.cwd };
		const s = await index.find(id);
		if (!s) throw new HttpError(404, "Session not found");
		return { messages: await readHistory(s.file), live: false, cwd: s.cwd, name: s.name, error: registry.lastError(id) ?? null };
	}

	function sessionStream(req: IncomingMessage, res: ServerResponse, cors: Cors, sessionId: string): void {
		const sse = openSse(res, cors);
		let id = sessionId;
		let detach: (() => void) | null = null;
		const attach = (h: SessionHandle) => {
			detach?.();
			const unsubscribe = h.subscribe((msg) => {
				if (msg.type === "snapshot") id = msg.snapshot.sessionId; // follows fork/clone/new
				sse.send(msg);
				if (msg.type === "handle_gone") {
					unsubscribe();
					detach = null;
					sse.send({ type: "detached" });
				}
			});
			detach = unsubscribe;
			sse.send({ type: "snapshot", snapshot: h.snapshot() });
		};
		const existing = registry.get(id);
		if (existing) attach(existing);
		else sse.send({ type: "detached" });
		const stopWatching = registry.onChange((m) => {
			if (detach || m.type !== "session_state" || m.sessionId !== id || !m.live) return;
			const h = registry.get(id);
			if (h) attach(h);
		});
		req.on("close", () => {
			detach?.();
			stopWatching();
			sse.close();
		});
	}

	function listStream(req: IncomingMessage, res: ServerResponse, cors: Cors): void {
		const sse = openSse(res, cors);
		const stop = registry.onChange((m) => sse.send(m));
		req.on("close", () => {
			stop();
			sse.close();
		});
	}

	return createServer(async (req, res) => {
		const cors = corsHeaders(cfg, req.headers.origin);
		try {
			if (req.method === "OPTIONS") {
				if (!cors["access-control-allow-origin"]) throw new HttpError(403, "Forbidden");
				res.writeHead(204, cors);
				res.end();
				return;
			}
			const auth = checkRequest(cfg, req.headers);
			if (!auth.ok) {
				log(`rejected ${req.method} ${req.url}: ${auth.reason}`);
				throw new HttpError(403, "Forbidden");
			}
			await route(req, res, cors);
		} catch (err) {
			const status = err instanceof HttpError ? err.status : 500;
			if (status === 500) log(`error ${req.method} ${req.url}: ${(err as Error).stack}`);
			if (!res.headersSent) sendJson(res, status, { error: (err as Error).message }, cors);
			else res.end();
		}
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown, cors: Cors): void {
	res.writeHead(status, { ...cors, "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

function openSse(res: ServerResponse, cors: Cors) {
	res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
	res.write(": connected\n\n");
	const ping = setInterval(() => res.write(": ping\n\n"), SSE_PING_MS);
	return {
		send(m: StreamMessage | ListMessage) {
			res.write(`data: ${JSON.stringify(m)}\n\n`);
		},
		close() {
			clearInterval(ping);
		},
	};
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > MAX_BODY) throw new HttpError(413, "Request too large");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "Invalid JSON");
	}
}

function parseCommand(body: unknown): AppCommand {
	const type = (body as { type?: unknown } | null)?.type;
	if (typeof type !== "string" || !(APP_COMMAND_TYPES as readonly string[]).includes(type)) throw new HttpError(400, `Unknown command: ${String(type)}`);
	const cmd = body as AppCommand;
	if (cmd.type === "prompt" && typeof cmd.text !== "string") throw new HttpError(400, "A prompt needs text");
	return cmd;
}
```

- [ ] **Step 5: Run the tests and typecheck to verify they pass**

Run: `npm test -w hub && npm run typecheck -w hub`
Expected: all tests pass and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add hub
git commit -m "feat(hub): HTTP API with CORS, identity checks and SSE streams

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Hub entrypoint and dev setup

**Files:**
- Create: `hub/src/main.ts`
- Modify: `hub/package.json` (add a `dev` script)

**Interfaces:**
- Consumes: everything in `hub/src`.
- Produces: `npm run start -w hub`, which is production and reads `~/.config/pi-web/config.json`, and `npm run dev -w hub`, which reads `.dev-data/config.json` at the repo root. Both listen on `127.0.0.1:<port>`.

- [ ] **Step 1: Write the entrypoint**

`hub/src/main.ts`:

```ts
// Starts the hub: config → session index → registry → HTTP server.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, type HubConfig, loadConfig } from "./config.ts";
import { Registry } from "./registry.ts";
import { RpcHandle } from "./rpc-handle.ts";
import { createHubServer } from "./server.ts";
import { SessionIndex, sessionsDir } from "./sessions.ts";

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

let cfg: HubConfig;
try {
	cfg = loadConfig();
} catch (err) {
	if (err instanceof ConfigError) {
		console.error(err.message);
		process.exit(1);
	}
	throw err;
}

const exportDir = join(cfg.dataDir, "exports");
mkdirSync(exportDir, { recursive: true });
const index = new SessionIndex(sessionsDir());
const registry = new Registry({
	factory: { startRpc: (o) => RpcHandle.start({ ...o, piBin: cfg.piBin, exportDir }) },
	lookup: index,
	maxHeadless: cfg.maxHeadless,
	idleMs: cfg.idleMinutes * 60_000,
});
setInterval(() => registry.reap(), 60_000).unref();

const server = createHubServer({ cfg, registry, index, version });
server.listen(cfg.port, "127.0.0.1", () => {
	console.log(`pi-web hub ${version} on http://127.0.0.1:${cfg.port} (serving https://${cfg.hostname}, sessions in ${index.dir})`);
});

const shutdown = () => {
	registry.closeAll();
	server.close();
	setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

Add to the `scripts` in `hub/package.json`:

```json
"dev": "PI_WEB_DATA_DIR=../.dev-data node --watch src/main.ts"
```

- [ ] **Step 2: Create the dev config and run the hub against your real sessions**

Run:
```bash
mkdir -p .dev-data
cat > .dev-data/config.json <<'EOF'
{ "port": 7878, "hostname": "localhost:5173", "allowedLogin": "dev@local", "dev": true }
EOF
npm run dev -w hub &
sleep 1
curl -s -H 'Origin: http://localhost:5173' -H 'Host: localhost:5173' -H 'Tailscale-User-Login: dev@local' http://127.0.0.1:7878/api/sessions | head -c 400; echo
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7878/api/sessions
```
Expected:
- The log line `pi-web hub 0.1.0 on http://127.0.0.1:7878 … sessions in /home/michael/.pi/agent/sessions`.
- The first curl prints JSON listing Michael's real sessions, such as the "I applied for a UX Design III role at JPL…" session.
- The second prints `403`.

(The dev config uses `localhost:5173` because Vite's proxy, set up in Task 9, forwards the browser's Host unchanged and injects the identity header.)

Stop it with `kill %1`.

- [ ] **Step 3: Check that an unconfigured production start explains itself**

Run: `PI_WEB_DATA_DIR=$(mktemp -d) npm run start -w hub; echo "exit $?"`
Expected: it prints "Set hostname and allowedLogin in …/config.json." with the two hints, then `exit 1`.

- [ ] **Step 4: Commit**

```bash
git add hub
git commit -m "feat(hub): entrypoint and dev mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: App scaffold: Vite, Lit, tokens, fonts, icons, PWA shell

**Files:**
- Create: `app/package.json`, `app/tsconfig.json`, `app/vite.config.ts`, `app/index.html`
- Create: `app/public/theme-init.js`, `app/public/manifest.webmanifest`, `app/public/sw.js`, and `app/public/fonts/` (copied)
- Create: `app/scripts/make-icons.mjs`, generating `app/public/icons/*`
- Create: `app/src/main.ts`, `app/src/styles/global.css`, `app/src/styles/shared.ts`, `app/src/lib/settings.ts`, and `app/src/components/pi-app.ts` (placeholder, replaced in Task 12)
- Test: `app/src/lib/settings.test.ts`

**Interfaces:**
- Produces:
  - `sharedStyles` (a Lit `CSSResult`) with the classes `.btn`, `.btn.ghost`, `.u`/`.u.on` (yellow underline), `.label`, `.dot.{live,running,needs_you,error}` and `.sr-only`
  - CSS tokens on `:root` and `[data-theme="dark"]`: `--primary --accent --success --bg --panel --text --text-2 --muted --border --line --code-bg --overlay --radius --font-display --font-body --font-quote --font-mono --sidebar-w`
  - from `settings.ts`: `getHubUrl(): string | null`, `setHubUrl(url: string): void`, `normalizeHubUrl(input: string): string`, `defaultHubUrl(loc?: { hostname: string; origin: string }): string | null`, `type ThemePref = "system" | "light" | "dark"`, `getTheme(): ThemePref`, `setTheme(p: ThemePref): void`

- [ ] **Step 1: Create the app package and install**

`app/package.json`:

```json
{
	"name": "@pi-web/app",
	"private": true,
	"type": "module",
	"scripts": {
		"dev": "vite",
		"build": "tsc -p tsconfig.json && vite build",
		"preview": "vite preview",
		"test": "vitest run",
		"typecheck": "tsc -p tsconfig.json",
		"icons": "node scripts/make-icons.mjs",
		"e2e": "playwright test"
	},
	"dependencies": { "lit": "3.3.3", "marked": "18.1.0" },
	"devDependencies": {
		"@playwright/test": "1.64.0",
		"@types/node": "26.6.5",
		"typescript": "5.9.3",
		"vite": "8.3.4",
		"vitest": "5.0.3"
	}
}
```

`app/tsconfig.json`:

```json
{
	"compilerOptions": {
		"target": "ES2023",
		"lib": ["ES2023", "DOM", "DOM.Iterable"],
		"module": "preserve",
		"moduleResolution": "bundler",
		"strict": true,
		"noEmit": true,
		"allowImportingTsExtensions": true,
		"verbatimModuleSyntax": true,
		"erasableSyntaxOnly": true,
		"useDefineForClassFields": true,
		"skipLibCheck": true,
		"types": ["vite/client", "node"]
	},
	"include": ["src", "e2e", "vite.config.ts", "playwright.config.ts"]
}
```

Run: `npm install`
Expected: lit, marked, vite, vitest and playwright are installed.

- [ ] **Step 2: Vite config with the dev identity proxy and the production CSP**

`app/vite.config.ts`:

```ts
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// In dev the app talks to the hub through Vite at the same origin. The proxy
// plays the part of `tailscale serve`: it adds the identity header the hub
// requires, and an Origin header for same-origin GETs (browsers omit it).
const HUB = process.env.PI_WEB_HUB ?? "http://127.0.0.1:7878";
const DEV_LOGIN = process.env.PI_WEB_DEV_LOGIN ?? "dev@local";
const DEV_ORIGIN = "http://localhost:5173";

const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self'",
	"img-src 'self' data: blob:",
	"connect-src 'self' https://*.ts.net",
	"manifest-src 'self'",
	"worker-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
].join("; ");

// Only built HTML gets the CSP, so Vite's dev client keeps working.
function csp(): Plugin {
	return {
		name: "pi-web-csp",
		apply: "build",
		transformIndexHtml: (html) => html.replace("<head>", `<head>\n\t\t<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
	};
}

export default defineConfig({
	plugins: [csp()],
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": {
				target: HUB,
				changeOrigin: false,
				configure(proxy) {
					proxy.on("proxyReq", (req) => {
						req.setHeader("tailscale-user-login", DEV_LOGIN);
						if (!req.getHeader("origin")) req.setHeader("origin", DEV_ORIGIN);
					});
				},
			},
		},
	},
	test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 3: HTML shell, theme bootstrap, manifest, service worker**

`app/index.html`:

```html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
		<meta name="theme-color" content="#f1f1f1" media="(prefers-color-scheme: light)" />
		<meta name="theme-color" content="#171717" media="(prefers-color-scheme: dark)" />
		<meta name="apple-mobile-web-app-capable" content="yes" />
		<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
		<meta name="apple-mobile-web-app-title" content="pi" />
		<meta name="description" content="pi, from anywhere: sessions, models and context for the pi coding agent." />
		<link rel="manifest" href="/manifest.webmanifest" />
		<link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
		<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
		<link rel="preload" href="/fonts/Inter.ttf" as="font" type="font/ttf" crossorigin />
		<link rel="preload" href="/fonts/Nunito.ttf" as="font" type="font/ttf" crossorigin />
		<title>pi, that's it.</title>
		<script src="/theme-init.js"></script>
	</head>
	<body>
		<pi-app></pi-app>
		<script type="module" src="/src/main.ts"></script>
	</body>
</html>
```

`app/public/theme-init.js`:

```js
// Runs before first paint (like thatsit.dev's inline script, but CSP-friendly).
(function () {
	var pref = "system";
	try {
		pref = localStorage.getItem("pi-web:theme") || "system";
	} catch (e) {}
	var media = window.matchMedia("(prefers-color-scheme: dark)");
	function apply() {
		var theme = pref === "light" || pref === "dark" ? pref : media.matches ? "dark" : "light";
		document.documentElement.setAttribute("data-theme", theme);
	}
	apply();
	media.addEventListener("change", function () {
		try {
			pref = localStorage.getItem("pi-web:theme") || "system";
		} catch (e) {}
		apply();
	});
})();
```

`app/public/manifest.webmanifest`:

```json
{
	"name": "pi, that's it.",
	"short_name": "pi",
	"description": "Sessions, models and context for the pi coding agent.",
	"start_url": "/",
	"scope": "/",
	"display": "standalone",
	"background_color": "#171717",
	"theme_color": "#171717",
	"icons": [
		{ "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
		{ "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
		{ "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
	]
}
```

`app/public/sw.js`:

```js
// App-shell service worker. Navigations: network first, cached shell offline.
// Hashed assets and fonts: cache first. The hub API is never cached.
const CACHE = "pi-web-v1";
const SHELL = ["/", "/manifest.webmanifest", "/theme-init.js", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	const url = new URL(req.url);
	if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
	if (req.mode === "navigate") {
		event.respondWith(
			fetch(req)
				.then((res) => {
					const copy = res.clone();
					caches.open(CACHE).then((c) => c.put("/", copy));
					return res;
				})
				.catch(() => caches.match("/")),
		);
		return;
	}
	event.respondWith(
		caches.match(req).then(
			(hit) =>
				hit ||
				fetch(req).then((res) => {
					if (res.ok) {
						const copy = res.clone();
						caches.open(CACHE).then((c) => c.put(req, copy));
					}
					return res;
				}),
		),
	);
});
```

- [ ] **Step 4: Fonts and icons**

Run:
```bash
mkdir -p app/public/fonts
F=~/workspace/ref/website/public/fonts   # clone with: git clone --depth 1 git@github.com:michaelthatsit/website.git ~/workspace/ref/website
cp "$F/Inter-VariableFont_opsz,wght.ttf" app/public/fonts/Inter.ttf
cp "$F/Nunito-VariableFont_wght.ttf" app/public/fonts/Nunito.ttf
cp "$F/WorkSans-VariableFont_wght.ttf" app/public/fonts/WorkSans.ttf
cp "$F/WorkSans-Italic-VariableFont_wght.ttf" app/public/fonts/WorkSans-Italic.ttf
ls app/public/fonts
```
Expected: four `.ttf` files.

`app/scripts/make-icons.mjs`. It writes PNG and SVG icons with no dependencies: a yellow dot (the site favicon's circle) on the dark background.

```js
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0x17, 0x17, 0x17];
const DOT = [0xff, 0xaa, 0x00];
const CRC = new Uint32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (buf) => {
	let c = 0xffffffff;
	for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}
function png(size, radiusFraction) {
	const stride = size * 3 + 1;
	const raw = Buffer.alloc(stride * size);
	const cx = size / 2;
	const cy = size * 0.53; // the site's favicon sits slightly low
	const r = size * radiusFraction;
	for (let y = 0; y < size; y++) {
		raw[y * stride] = 0;
		for (let x = 0; x < size; x++) {
			const a = Math.min(1, Math.max(0, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5));
			const o = y * stride + 1 + x * 3;
			for (let i = 0; i < 3; i++) raw[o + i] = Math.round(BG[i] * (1 - a) + DOT[i] * a);
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const out = new URL("../public/icons/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const [name, size, frac] of [
	["icon-192.png", 192, 0.31],
	["icon-512.png", 512, 0.31],
	["icon-maskable-512.png", 512, 0.24],
	["apple-touch-icon.png", 180, 0.31],
]) {
	writeFileSync(new URL(name, out), png(size, frac));
}
writeFileSync(
	new URL("icon.svg", out),
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#171717"/><circle cx="16" cy="17" r="10" fill="#FFAA00"/></svg>\n',
);
console.log("icons written to app/public/icons");
```

Run: `npm run icons -w app && file app/public/icons/*.png`
Expected: four lines like `PNG image data, 512 x 512, 8-bit/color RGB, non-interlaced`.

- [ ] **Step 5: Global styles and shared component styles**

`app/src/styles/global.css`:

```css
/* Tokens copied from thatsit.dev (website/src/styles/base.css). Direction "b · instrument". */
@font-face { font-family: "Inter"; src: url("/fonts/Inter.ttf") format("truetype"); font-weight: 100 900; font-style: normal; font-display: swap; }
@font-face { font-family: "Nunito"; src: url("/fonts/Nunito.ttf") format("truetype"); font-weight: 200 1000; font-style: normal; font-display: swap; }
@font-face { font-family: "Work Sans"; src: url("/fonts/WorkSans.ttf") format("truetype"); font-weight: 100 900; font-style: normal; font-display: swap; }
@font-face { font-family: "Work Sans"; src: url("/fonts/WorkSans-Italic.ttf") format("truetype"); font-weight: 100 900; font-style: italic; font-display: swap; }

:root {
	--primary: #e4002b;
	--accent: #ffaa00;
	--success: #00843d;
	--bg: #f1f1f1;
	--panel: #e7e7e7;
	--text: #000000;
	--text-2: #555555;
	--muted: #64748b;
	--border: #555555;
	--line: #cfcfcf;
	--code-bg: #e2e8f0;
	--overlay: rgba(0, 0, 0, 0.45);
	--radius: 0.15rem;
	--font-display: "Nunito", ui-rounded, system-ui, sans-serif;
	--font-body: "Inter", system-ui, -apple-system, sans-serif;
	--font-quote: "Work Sans", system-ui, sans-serif;
	--font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	--sidebar-w: 280px;
	color-scheme: light;
}

[data-theme="dark"] {
	--bg: #171717;
	--panel: #1f1f1f;
	--text: #ffffff;
	--text-2: #a1a1aa;
	--muted: #94a3b8;
	--line: #333333;
	--code-bg: #1e293b;
	--overlay: rgba(0, 0, 0, 0.6);
	color-scheme: dark;
}

*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; }
html { background: var(--bg); }
body {
	margin: 0;
	background: var(--bg);
	color: var(--text);
	font-family: var(--font-body);
	font-size: 15px;
	line-height: 1.55;
	-webkit-text-size-adjust: 100%;
	transition: background-color 0.3s ease, color 0.3s ease;
}
pi-app { display: block; height: 100%; }
```

`app/src/styles/shared.ts`:

```ts
import { css } from "lit";

// Small vocabulary shared by every component (shadow DOM doesn't inherit page CSS).
export const sharedStyles = css`
	:host { box-sizing: border-box; }
	*, *::before, *::after { box-sizing: inherit; }
	a { color: var(--accent); text-decoration: none; }
	button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
	input, textarea, select {
		font: inherit;
		font-size: 16px; /* stops iOS zooming on focus */
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 7px 10px;
	}
	:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.u { position: relative; }
	.u::after { content: ""; position: absolute; left: 0; bottom: -3px; height: 2px; width: 0; background: var(--accent); transition: width 0.2s ease-out; }
	.u:hover::after, .u.on::after { width: 100%; }
	.btn {
		display: inline-flex; align-items: center; justify-content: center; gap: 6px;
		background: var(--primary); color: #fff;
		border: 1px solid var(--primary); border-radius: var(--radius);
		padding: 6px 12px; font-weight: 500; font-size: 0.9rem; line-height: 1.2;
	}
	.btn:disabled { opacity: 0.45; cursor: default; }
	.btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
	.label { font-family: var(--font-display); letter-spacing: 0.12em; text-transform: lowercase; color: var(--muted); font-size: 0.75rem; }
	.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }
	.dot.live { background: var(--accent); }
	.dot.running { background: var(--primary); animation: pulse 1.4s ease-in-out infinite; }
	.dot.needs_you { background: var(--primary); }
	.dot.error { background: transparent; box-shadow: inset 0 0 0 2px var(--primary); }
	@keyframes pulse { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary), transparent 70%); } }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
	@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;
```

- [ ] **Step 6: Write the failing settings tests**

`app/src/lib/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultHubUrl, normalizeHubUrl } from "./settings.ts";

describe("normalizeHubUrl", () => {
	it("adds https and drops paths", () => {
		expect(normalizeHubUrl("spark-713a.tail9274fa.ts.net:7878")).toBe("https://spark-713a.tail9274fa.ts.net:7878");
		expect(normalizeHubUrl(" https://spark-713a.tail9274fa.ts.net:7878/api/ ")).toBe("https://spark-713a.tail9274fa.ts.net:7878");
		expect(normalizeHubUrl("http://localhost:5173")).toBe("http://localhost:5173");
	});
	it("rejects junk", () => {
		expect(() => normalizeHubUrl("not a url at all")).toThrow();
	});
});

describe("defaultHubUrl", () => {
	it("uses the dev server's own origin on localhost only", () => {
		expect(defaultHubUrl({ hostname: "localhost", origin: "http://localhost:5173" })).toBe("http://localhost:5173");
		expect(defaultHubUrl({ hostname: "pi.thatsit.dev", origin: "https://pi.thatsit.dev" })).toBe(null);
	});
});
```

Run: `npm test -w app`
Expected: FAIL, because `settings.ts` doesn't exist.

- [ ] **Step 7: Implement settings, the placeholder shell, and main**

`app/src/lib/settings.ts`:

```ts
// Per-device settings in localStorage. Every access is guarded: private mode
// and blocked storage must not break the app.

const HUB_KEY = "pi-web:hub";
const THEME_KEY = "pi-web:theme";

export type ThemePref = "system" | "light" | "dark";

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {}
}

export function normalizeHubUrl(input: string): string {
	let s = input.trim();
	if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
	const url = new URL(s);
	if (!url.hostname.includes(".") && url.hostname !== "localhost") throw new Error(`"${input}" doesn't look like a hub address`);
	return url.origin;
}

// On the Vite dev server the hub is proxied at the same origin.
export function defaultHubUrl(loc: { hostname: string; origin: string } = location): string | null {
	return loc.hostname === "localhost" || loc.hostname === "127.0.0.1" ? loc.origin : null;
}

export function getHubUrl(): string | null {
	return read(HUB_KEY) ?? defaultHubUrl();
}

export function setHubUrl(url: string): void {
	write(HUB_KEY, normalizeHubUrl(url));
}

export function getTheme(): ThemePref {
	const t = read(THEME_KEY);
	return t === "light" || t === "dark" ? t : "system";
}

export function setTheme(pref: ThemePref): void {
	write(THEME_KEY, pref === "system" ? null : pref);
	const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}
```

`app/src/components/pi-app.ts` (placeholder until Task 12):

```ts
import { LitElement, css, html } from "lit";
import { sharedStyles } from "../styles/shared.ts";

export class PiApp extends LitElement {
	static styles = [sharedStyles, css`:host { display: grid; place-items: center; height: 100%; } h1 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.1em; font-size: 3rem; }`];
	render() {
		return html`<h1><span class="u on">pi</span></h1>`;
	}
}
customElements.define("pi-app", PiApp);
```

`app/src/main.ts`:

```ts
import "./styles/global.css";
import "./components/pi-app.ts";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js").catch(() => {});
}
```

- [ ] **Step 8: Verify tests, dev server and build**

Run:
```bash
npm test -w app
npm run typecheck -w app
(npm run dev -w app > /tmp/vite.log 2>&1 &) ; sleep 3; curl -s localhost:5173/ | grep -c "pi-app"; kill %1 2>/dev/null; pkill -f "vite" || true
npm run build -w app && grep -c "Content-Security-Policy" app/dist/index.html
```
Expected:
- the settings tests pass
- tsc exits 0
- the dev page contains `pi-app` (count ≥ 1)
- the build succeeds and `dist/index.html` has the CSP meta (count 1)

- [ ] **Step 9: Commit**

```bash
git add app package-lock.json
git commit -m "feat(app): Vite + Lit scaffold with thatsit.dev tokens, fonts, icons and PWA shell

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: App helpers: routes, formatting, markdown, slash commands

**Files:**
- Create: `app/src/lib/route.ts`, `app/src/lib/format.ts`, `app/src/lib/markdown.ts`, `app/src/lib/slash.ts`
- Test: `app/src/lib/route.test.ts`, `app/src/lib/format.test.ts`, `app/src/lib/markdown.test.ts`, `app/src/lib/slash.test.ts`

**Interfaces:**
- Consumes: shared protocol types.
- Produces:
  - **route.ts:** `type Route = { name: "home" } | { name: "session"; id: string } | { name: "new"; cwd?: string } | { name: "settings" }`, `parseRoute(hash: string): Route`, `hrefFor(r: Route): string`
  - **format.ts:**
    - `formatTokens(n?: number | null): string`
    - `formatCost(usd: number): string`
    - `relativeTime(ts: number, now?: number): string`
    - `abbreviateCwd(cwd: string, home: string): string`
    - `sessionTitle(s: { name: string | null; firstPrompt: string | null }): string`
    - `groupSessions(sessions: SessionSummary[], query: string, home: string): SessionGroup[]`, where `SessionGroup = { cwd; label; sessions }`
    - `summarizeToolArgs(name: string, args: unknown): string`
    - `parseArgsRaw(raw?: string): Record<string, unknown>`
    - `truncateOutput(text: string, limit?: number): string` and `OUTPUT_LIMIT = 20000`
    - `wordCount(s: string): number`
    - `blocksText(content: unknown): string`
  - **markdown.ts:** `renderMarkdown(src: string): string` (sanitized and cached)
  - **slash.ts:**
    - `type SlashItem = { name; description; kind: "builtin" | "extension" | "prompt" | "skill"; rpcOnly?: boolean }`
    - `BUILTINS: SlashItem[]` and `BUILTIN_NAMES: Set<string>`
    - `slashItems(commands: CommandInfo[]): SlashItem[]`
    - `slashQuery(input: string): string | null`
    - `filterSlash(items: SlashItem[], query: string, limit?: number): SlashItem[]`
    - `type ParsedInput` and `parseInput(text: string): ParsedInput`
    - `matchModel(models: ModelInfo[], query: string): ModelInfo | null`

- [ ] **Step 1: Write the failing tests**

`app/src/lib/route.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hrefFor, parseRoute } from "./route.ts";

describe("routes", () => {
	it("parses hashes", () => {
		expect(parseRoute("")).toEqual({ name: "home" });
		expect(parseRoute("#/s/01a113f5-669d")).toEqual({ name: "session", id: "01a113f5-669d" });
		expect(parseRoute("#/new?cwd=%2Fhome%2Fmichael")).toEqual({ name: "new", cwd: "/home/michael" });
		expect(parseRoute("#/new")).toEqual({ name: "new" });
		expect(parseRoute("#/settings")).toEqual({ name: "settings" });
		expect(parseRoute("#/whatever")).toEqual({ name: "home" });
	});
	it("round-trips", () => {
		for (const r of [{ name: "home" }, { name: "session", id: "abc" }, { name: "new", cwd: "/a b" }, { name: "settings" }] as const) {
			expect(parseRoute(hrefFor(r))).toEqual(r);
		}
	});
});
```

`app/src/lib/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../../shared/src/protocol.ts";
import { OUTPUT_LIMIT, abbreviateCwd, blocksText, formatCost, formatTokens, groupSessions, parseArgsRaw, relativeTime, sessionTitle, summarizeToolArgs, truncateOutput, wordCount } from "./format.ts";

const s = (over: Partial<SessionSummary>): SessionSummary => ({
	id: "x", cwd: "/home/m", name: null, firstPrompt: null, userMessages: 1, model: null, contextTokens: null,
	createdAt: 0, updatedAt: 0, parentSession: null, live: false, handleKind: null, state: "idle", ...over,
});

describe("format", () => {
	it("formats token counts like the TUI footer", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1000)).toBe("1k");
		expect(formatTokens(62_100)).toBe("62.1k");
		expect(formatTokens(262_144)).toBe("262k");
		expect(formatTokens(1_200_000)).toBe("1.2M");
		expect(formatTokens(null)).toBe("—");
	});
	it("formats cost only when non-zero", () => {
		expect(formatCost(0)).toBe("");
		expect(formatCost(0.004)).toBe("<$0.01");
		expect(formatCost(0.45)).toBe("$0.45");
	});
	it("formats relative time compactly", () => {
		const now = 1_000_000_000;
		expect(relativeTime(now - 10_000, now)).toBe("now");
		expect(relativeTime(now - 2 * 60_000, now)).toBe("2m");
		expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
		expect(relativeTime(now - 5 * 86_400_000, now)).toBe("5d");
	});
	it("abbreviates home", () => {
		expect(abbreviateCwd("/home/michael/workspace/website", "/home/michael")).toBe("~/workspace/website");
		expect(abbreviateCwd("/home/michael", "/home/michael")).toBe("~");
		expect(abbreviateCwd("/home/michaelx", "/home/michael")).toBe("/home/michaelx");
	});
	it("titles sessions by name, then first prompt line", () => {
		expect(sessionTitle({ name: "katsu", firstPrompt: "How do I…" })).toBe("katsu");
		expect(sessionTitle({ name: null, firstPrompt: "line one\nline two" })).toBe("line one");
		expect(sessionTitle({ name: null, firstPrompt: null })).toBe("new session");
	});
	it("groups by folder in recency order and filters by query", () => {
		const list = [s({ id: "a", cwd: "/home/m/site", name: "portfolio" }), s({ id: "b", cwd: "/home/m" , firstPrompt: "katsu" }), s({ id: "c", cwd: "/home/m/site", firstPrompt: "nav" })];
		const groups = groupSessions(list, "", "/home/m");
		expect(groups.map((g) => g.label)).toEqual(["~/site", "~"]);
		expect(groups[0].sessions.map((x) => x.id)).toEqual(["a", "c"]);
		expect(groupSessions(list, "KATSU", "/home/m").flatMap((g) => g.sessions.map((x) => x.id))).toEqual(["b"]);
	});
	it("summarizes tool arguments on one line", () => {
		expect(summarizeToolArgs("bash", { command: "curl -sL\n  thatsit.dev" })).toBe("curl -sL thatsit.dev");
		expect(summarizeToolArgs("read", { path: "src/index.md" })).toBe("src/index.md");
		expect(summarizeToolArgs("custom", { a: 1 })).toBe('{"a":1}');
		expect(summarizeToolArgs("bash", { command: "x".repeat(300) }).length).toBe(120);
	});
	it("pulls a readable argument out of partial streaming JSON", () => {
		expect(parseArgsRaw('{"command":"ls -la')).toEqual({ command: "ls -la" });
		expect(parseArgsRaw('{"path":"a.ts"}')).toEqual({ path: "a.ts" });
		expect(parseArgsRaw(undefined)).toEqual({});
	});
	it("truncates huge tool output with a note", () => {
		const big = "y".repeat(5_000_000);
		const out = truncateOutput(big);
		expect(out.length).toBeLessThan(OUTPUT_LIMIT + 100);
		expect(out).toMatch(/… 4980000 more characters$/);
		expect(truncateOutput("short")).toBe("short");
	});
	it("counts words and extracts text blocks", () => {
		expect(wordCount("  a b\nc ")).toBe(3);
		expect(wordCount("")).toBe(0);
		expect(blocksText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\nb");
		expect(blocksText(undefined)).toBe("");
	});
});
```

`app/src/lib/markdown.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.ts";

describe("renderMarkdown", () => {
	it("renders ordinary markdown", () => {
		expect(renderMarkdown("**bold** and `code`")).toContain("<strong>bold</strong>");
		expect(renderMarkdown("```\n<b>x</b>\n```")).toContain("&lt;b&gt;x&lt;/b&gt;");
	});
	it("escapes raw HTML from the model", () => {
		const out = renderMarkdown('<script>alert(1)</script>\n\nhi <img src=x onerror="alert(1)">');
		expect(out).not.toMatch(/<script|<img/i);
		expect(out).toContain("&lt;script&gt;");
	});
	it("only links http(s) and mailto", () => {
		expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a");
		const ok = renderMarkdown("[site](https://thatsit.dev/?a=1&b=2)");
		expect(ok).toContain('href="https://thatsit.dev/?a=1&amp;b=2"');
		expect(ok).toContain('rel="noopener noreferrer"');
	});
	it("turns images into links instead of loading them", () => {
		const out = renderMarkdown("![diagram](https://example.com/a.png)");
		expect(out).not.toContain("<img");
		expect(out).toContain('href="https://example.com/a.png"');
	});
});
```

`app/src/lib/slash.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../../shared/src/protocol.ts";
import { BUILTINS, filterSlash, matchModel, parseInput, slashItems, slashQuery } from "./slash.ts";

const model = (provider: string, id: string, name: string): ModelInfo => ({ provider, id, name, reasoning: true, input: ["text"], contextWindow: 262144, maxTokens: 32768 });

describe("slash commands", () => {
	it("detects a command being typed", () => {
		expect(slashQuery("/")).toBe("");
		expect(slashQuery("/co")).toBe("co");
		expect(slashQuery("/compact now")).toBe(null);
		expect(slashQuery("hello /co")).toBe(null);
	});
	it("merges pi commands after built-ins, without duplicates", () => {
		const items = slashItems([
			{ name: "council", description: "prompt template", source: "prompt" },
			{ name: "model", description: "shadowed", source: "extension" },
		]);
		expect(items.slice(0, BUILTINS.length)).toEqual(BUILTINS);
		expect(items.filter((i) => i.name === "model")).toHaveLength(1);
		expect(items.at(-1)).toMatchObject({ name: "council", kind: "prompt" });
	});
	it("ranks prefix, then substring, then subsequence matches", () => {
		const items = slashItems([
			{ name: "context", source: "extension" },
			{ name: "council", source: "prompt" },
			{ name: "skill:ctx-stats", source: "skill" },
		]);
		expect(filterSlash(items, "co").map((i) => i.name)).toEqual(["copy", "compact", "context", "council", "clone"]);
		expect(filterSlash(items, "ctxst").map((i) => i.name)).toEqual(["skill:ctx-stats"]);
		expect(filterSlash(items, "").slice(0, 2).map((i) => i.name)).toEqual(["model", "thinking"]);
	});
	it("parses built-ins, shell commands and prompts", () => {
		expect(parseInput("/compact keep the API notes")).toEqual({ kind: "builtin", name: "compact", args: "keep the API notes" });
		expect(parseInput("/model")).toEqual({ kind: "builtin", name: "model", args: "" });
		expect(parseInput("!ls -la")).toEqual({ kind: "bash", command: "ls -la", excludeFromContext: false });
		expect(parseInput("!!git status")).toEqual({ kind: "bash", command: "git status", excludeFromContext: true });
		expect(parseInput("/council review this")).toEqual({ kind: "prompt", text: "/council review this" });
		expect(parseInput("!")).toEqual({ kind: "prompt", text: "!" });
		expect(parseInput("hello")).toEqual({ kind: "prompt", text: "hello" });
	});
	it("matches models by id, provider/id, or a unique fragment", () => {
		const models = [model("spark", "qwen3.8-27b", "Qwen3.8 27B (coding)"), model("spark", "qwen3.6-35b-a3b-sglang", "Qwen3.6 35B-A3B (fast)"), model("spark", "qwen3.8-flash-next", "Qwen3.8 Flash-Next (max)")];
		expect(matchModel(models, "qwen3.8-27b")?.id).toBe("qwen3.8-27b");
		expect(matchModel(models, "spark/qwen3.8-flash-next")?.id).toBe("qwen3.8-flash-next");
		expect(matchModel(models, "fast")?.id).toBe("qwen3.6-35b-a3b-sglang");
		expect(matchModel(models, "qwen3.8")).toBe(null);
		expect(matchModel(models, "gpt")).toBe(null);
	});
});
```

Run: `npm test -w app`
Expected: FAIL for all four files, because the modules don't exist.

- [ ] **Step 2: Implement the helpers**

`app/src/lib/route.ts`:

```ts
export type Route = { name: "home" } | { name: "session"; id: string } | { name: "new"; cwd?: string } | { name: "settings" };

export function parseRoute(hash: string): Route {
	const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
	const parts = path.split("/").filter(Boolean);
	if (parts[0] === "s" && parts[1]) return { name: "session", id: decodeURIComponent(parts[1]) };
	if (parts[0] === "new") {
		const cwd = new URLSearchParams(query).get("cwd");
		return cwd ? { name: "new", cwd } : { name: "new" };
	}
	if (parts[0] === "settings") return { name: "settings" };
	return { name: "home" };
}

export function hrefFor(r: Route): string {
	switch (r.name) {
		case "home":
			return "#/";
		case "session":
			return `#/s/${encodeURIComponent(r.id)}`;
		case "new":
			return r.cwd ? `#/new?${new URLSearchParams({ cwd: r.cwd })}` : "#/new";
		case "settings":
			return "#/settings";
	}
}
```

`app/src/lib/format.ts`:

```ts
import type { SessionSummary } from "../../../shared/src/protocol.ts";

const trimZero = (s: string) => s.replace(/\.0$/, "");

export function formatTokens(n?: number | null): string {
	if (n == null) return "—";
	if (n < 1000) return String(n);
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k >= 100 ? Math.round(k) : trimZero(k.toFixed(1))}k`;
	}
	const m = n / 1_000_000;
	return `${m >= 100 ? Math.round(m) : trimZero(m.toFixed(1))}M`;
}

export function formatCost(usd: number): string {
	if (!usd) return "";
	return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function relativeTime(ts: number, now = Date.now()): string {
	const s = Math.max(0, (now - ts) / 1000);
	if (s < 45) return "now";
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86_400) return `${Math.round(s / 3600)}h`;
	if (s < 86_400 * 30) return `${Math.round(s / 86_400)}d`;
	return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function abbreviateCwd(cwd: string, home: string): string {
	if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
	return cwd;
}

export function sessionTitle(s: { name: string | null; firstPrompt: string | null }): string {
	return s.name || s.firstPrompt?.split("\n")[0].slice(0, 80) || "new session";
}

export interface SessionGroup {
	cwd: string;
	label: string;
	sessions: SessionSummary[];
}

// Input is newest-first, so groups come out ordered by their newest session.
export function groupSessions(sessions: SessionSummary[], query: string, home: string): SessionGroup[] {
	const q = query.trim().toLowerCase();
	const groups = new Map<string, SessionGroup>();
	for (const s of sessions) {
		if (q && ![s.name, s.firstPrompt, s.cwd].some((v) => v?.toLowerCase().includes(q))) continue;
		let g = groups.get(s.cwd);
		if (!g) {
			g = { cwd: s.cwd, label: abbreviateCwd(s.cwd, home), sessions: [] };
			groups.set(s.cwd, g);
		}
		g.sessions.push(s);
	}
	return [...groups.values()];
}

const ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url"];

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function summarizeToolArgs(_name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const key = ARG_KEYS.find((k) => typeof a[k] === "string");
	const text = key ? (a[key] as string) : Object.keys(a).length ? JSON.stringify(a) : "";
	return oneLine(text, 120);
}

// Tool-call arguments arrive as partial JSON while streaming.
export function parseArgsRaw(raw?: string): Record<string, unknown> {
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		const m = raw.match(/"(command|path|file_path|pattern|query|url)"\s*:\s*"((?:[^"\\]|\\.)*)/);
		return m ? { [m[1]]: m[2].replace(/\\n/g, "\n").replace(/\\"/g, '"') } : {};
	}
}

export const OUTPUT_LIMIT = 20_000;

export function truncateOutput(text: string, limit = OUTPUT_LIMIT): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n… ${text.length - limit} more characters`;
}

export function wordCount(s: string): number {
	const t = s.trim();
	return t ? t.split(/\s+/).length : 0;
}

export function blocksText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}
```

`app/src/lib/markdown.ts`:

```ts
// Model and tool output is untrusted, and this app can run shell commands, so
// raw HTML is escaped and only http(s)/mailto links survive. Images become
// links so nothing loads from third-party hosts.

import { Marked, type Tokens } from "marked";

const SAFE_URL = /^(https?:|mailto:)/i;
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);
const link = (href: string, inner: string) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;

const md = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		html(token: Tokens.HTML | Tokens.Tag) {
			return esc(token.text);
		},
		link(token: Tokens.Link) {
			const inner = this.parser.parseInline(token.tokens);
			return SAFE_URL.test(token.href) ? link(token.href, inner) : inner;
		},
		image(token: Tokens.Image) {
			const label = esc(token.text || token.href);
			return SAFE_URL.test(token.href) ? link(token.href, label) : label;
		},
	},
});

const cache = new Map<string, string>();

export function renderMarkdown(src: string): string {
	const hit = cache.get(src);
	if (hit !== undefined) return hit;
	const out = md.parse(src, { async: false }) as string;
	if (cache.size >= 500) cache.delete(cache.keys().next().value as string);
	cache.set(src, out);
	return out;
}
```

`app/src/lib/slash.ts`:

```ts
import type { CommandInfo, ModelInfo } from "../../../shared/src/protocol.ts";

export interface SlashItem {
	name: string;
	description: string;
	kind: "builtin" | CommandInfo["source"];
	rpcOnly?: boolean; // unavailable while the session is open in the terminal (Plan 2)
}

// TUI built-ins that RPC doesn't expose; the app implements them (spec §5.3).
export const BUILTINS: SlashItem[] = [
	{ name: "model", description: "switch model, or /model <name>", kind: "builtin" },
	{ name: "thinking", description: "set thinking level, or /thinking <level>", kind: "builtin" },
	{ name: "compact", description: "compact context, optionally with instructions", kind: "builtin" },
	{ name: "name", description: "name this session, or show its name", kind: "builtin" },
	{ name: "session", description: "session stats and info", kind: "builtin" },
	{ name: "new", description: "start a new session", kind: "builtin" },
	{ name: "resume", description: "browse sessions", kind: "builtin" },
	{ name: "copy", description: "copy the last reply", kind: "builtin" },
	{ name: "fork", description: "new session from an earlier message", kind: "builtin", rpcOnly: true },
	{ name: "clone", description: "copy this session into a new one", kind: "builtin", rpcOnly: true },
	{ name: "export", description: "download this session as HTML", kind: "builtin", rpcOnly: true },
];

export const BUILTIN_NAMES = new Set(BUILTINS.map((b) => b.name));

export function slashItems(commands: CommandInfo[]): SlashItem[] {
	return [
		...BUILTINS,
		...commands.filter((c) => !BUILTIN_NAMES.has(c.name)).map((c) => ({ name: c.name, description: c.description || c.source, kind: c.source })),
	];
}

export function slashQuery(input: string): string | null {
	const m = input.match(/^\/(\S*)$/);
	return m ? m[1] : null;
}

function score(name: string, q: string): number {
	if (!q) return 1;
	if (name.startsWith(q)) return 3;
	if (name.includes(q)) return 2;
	let i = 0;
	for (const ch of name) if (ch === q[i]) i++;
	return i === q.length ? 1 : 0;
}

export function filterSlash(items: SlashItem[], query: string, limit = 8): SlashItem[] {
	const q = query.toLowerCase();
	return items
		.map((item) => ({ item, score: score(item.name.toLowerCase(), q) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || (q ? a.item.name.length - b.item.name.length : 0))
		.slice(0, limit)
		.map((x) => x.item);
}

export type ParsedInput =
	| { kind: "builtin"; name: string; args: string }
	| { kind: "bash"; command: string; excludeFromContext: boolean }
	| { kind: "prompt"; text: string };

export function parseInput(text: string): ParsedInput {
	const t = text.trim();
	const bang = t.match(/^(!!?)\s*([\s\S]+)$/);
	if (bang) return { kind: "bash", command: bang[2].trim(), excludeFromContext: bang[1] === "!!" };
	const slash = t.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
	if (slash && BUILTIN_NAMES.has(slash[1])) return { kind: "builtin", name: slash[1], args: (slash[2] ?? "").trim() };
	return { kind: "prompt", text };
}

export function matchModel(models: ModelInfo[], query: string): ModelInfo | null {
	const q = query.trim().toLowerCase();
	const exact = models.find((m) => m.id.toLowerCase() === q || `${m.provider}/${m.id}`.toLowerCase() === q);
	if (exact) return exact;
	const hits = models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
	return hits.length === 1 ? hits[0] : null;
}
```

- [ ] **Step 3: Run the tests and typecheck to verify they pass**

Run: `npm test -w app && npm run typecheck -w app`
Expected: all tests pass and tsc exits 0. If the markdown link test shows `&amp;amp;`, then marked already escaped the href. In that case drop `esc()` around the href in `link()` and re-run the test.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib
git commit -m "feat(app): routing, formatting, sanitized markdown and slash command helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: App data layer: hub API, streams, session and list stores

**Files:**
- Create: `app/src/lib/api.ts`, `app/src/lib/stream.ts`, `app/src/lib/session-store.ts`, `app/src/lib/list-store.ts`, `app/src/lib/toast.ts`
- Test: `app/src/lib/api.test.ts`, `app/src/lib/stream.test.ts`, `app/src/lib/session-store.test.ts`, `app/src/lib/list-store.test.ts`

**Interfaces:**
- Consumes: shared protocol and reducer.
- Produces:
  - **api.ts:**
    - `class HubError extends Error { status: number }`
    - `class HubApi`, constructed with `constructor(base: string)`, with these methods:

      | Method | Returns |
      |---|---|
      | `health()` | `Promise<HealthInfo>` |
      | `sessions()` | `Promise<{ sessions: SessionSummary[]; home: string }>` |
      | `cwds()` | `Promise<{ cwds: string[]; home: string }>` |
      | `createSession(cwd)` | `Promise<{ sessionId: string }>` |
      | `history(id)` | `Promise<HistoryResponse>` |
      | `command(id, cmd)` | `Promise<{ result: CommandResult; sessionId: string }>` |
      | `close(id)` | |
      | `streamUrl(id)`, `eventsUrl()` | `string` |
      | `downloadExport(name)` | `Promise<void>` |

    - `HistoryResponse = { messages: AgentMessage[]; live: boolean; cwd: string; name?: string | null; error?: string | null }`
  - **stream.ts:** `openStream<T>(url, onMessage: (m: T) => void, onStatus: (s: StreamStatus) => void, ES?: EventSourceCtor, schedule?: typeof setTimeout): { close(): void }`, where `StreamStatus = "connecting" | "open" | "reconnecting"`
  - **session-store.ts:** `class SessionStore extends EventTarget`
    - fields:
      - `id: string`
      - `snapshot: Snapshot | null`
      - `conv: Conversation`
      - `status: SessionStatus`
      - `dialogs: Dialog[]`
      - `dialogSeenAt: Map<string, number>`
      - `cwdHint: string | null`
      - `nameHint: string | null`
      - `lastExit: string | null`
    - methods: `setHistory(h: HistoryResponse)`, `markStarting()`, `cancelStarting()`, `setStreamStatus(s: StreamStatus)`, `apply(m: StreamMessage)`
    - events:
      - `"change"`
      - `"snapshot"`
      - `"notice"` (a `CustomEvent<StreamMessage>` for notify, editor_text, command_error and error)
    - `SessionStatus = "loading" | "history" | "starting" | "live" | "reconnecting"`
  - **list-store.ts:** `class ListStore extends EventTarget`
    - constructed with `constructor(api: Pick<HubApi, "sessions" | "eventsUrl">, open?: typeof openStream)`
    - fields: `sessions`, `home`, `error`, `loaded`
    - methods: `start()`, `stop()`, `refresh()`, `apply(m: ListMessage)`
    - fires `"change"`
  - **toast.ts:** `toast(message: string, level?: ToastLevel): void`, which dispatches `window` `"pi-toast"` with `CustomEvent<ToastDetail>`

- [ ] **Step 1: Write the failing tests**

`app/src/lib/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubApi, HubError } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("HubApi", () => {
	it("calls the hub with JSON and returns the body", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { ok: true }, sessionId: "s1" }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const api = new HubApi("https://spark-713a.tail9274fa.ts.net:7878/");
		const r = await api.command("s1", { type: "abort" });
		expect(r).toEqual({ result: { ok: true }, sessionId: "s1" });
		expect(fetchMock).toHaveBeenCalledWith("https://spark-713a.tail9274fa.ts.net:7878/api/sessions/s1/commands", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"type":"abort"}',
		});
		expect(api.streamUrl("a b")).toBe("https://spark-713a.tail9274fa.ts.net:7878/api/sessions/a%20b/stream");
	});
	it("turns hub errors into HubError with the hub's message", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "6 pi sessions are already running. Close one first." }), { status: 503 })));
		await expect(new HubApi("http://x").createSession("~")).rejects.toMatchObject({ status: 503, message: "6 pi sessions are already running. Close one first." });
	});
	it("explains network failures", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
		const err = await new HubApi("http://x").sessions().catch((e) => e);
		expect(err).toBeInstanceOf(HubError);
		expect(err.status).toBe(0);
		expect(err.message).toBe("Can't reach the hub. Is Tailscale connected?");
	});
});
```

`app/src/lib/stream.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type EventSourceLike, openStream } from "./stream.ts";

class FakeES implements EventSourceLike {
	static all: FakeES[] = [];
	onopen: ((e: Event) => void) | null = null;
	onmessage: ((e: MessageEvent) => void) | null = null;
	onerror: ((e: Event) => void) | null = null;
	closed = false;
	url: string;
	constructor(url: string) {
		this.url = url;
		FakeES.all.push(this);
	}
	close() {
		this.closed = true;
	}
}

describe("openStream", () => {
	it("parses messages, reconnects with backoff, and resets after a good connection", () => {
		FakeES.all = [];
		const delays: number[] = [];
		const pending: Array<() => void> = [];
		const schedule = ((fn: () => void, ms: number) => {
			delays.push(ms);
			pending.push(fn);
			return 0;
		}) as unknown as typeof setTimeout;
		const got: unknown[] = [];
		const statuses: string[] = [];
		const s = openStream("u", (m) => got.push(m), (st) => statuses.push(st), FakeES, schedule);
		FakeES.all[0].onopen?.(new Event("open"));
		FakeES.all[0].onmessage?.({ data: '{"type":"detached"}' } as MessageEvent);
		FakeES.all[0].onmessage?.({ data: "not json" } as MessageEvent);
		expect(got).toEqual([{ type: "detached" }]);
		FakeES.all[0].onerror?.(new Event("error"));
		pending.shift()?.();
		FakeES.all[1].onerror?.(new Event("error"));
		pending.shift()?.();
		FakeES.all[2].onopen?.(new Event("open"));
		FakeES.all[2].onerror?.(new Event("error"));
		expect(delays).toEqual([1000, 2000, 1000]);
		expect(statuses).toEqual(["connecting", "open", "reconnecting", "reconnecting", "open", "reconnecting"]);
		expect(FakeES.all[0].closed).toBe(true);
		s.close();
		expect(FakeES.all.at(-1)?.closed).toBe(true);
	});
});
```

`app/src/lib/session-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Snapshot, StreamMessage } from "../../../shared/src/protocol.ts";
import { createConversation } from "../../../shared/src/reducer.ts";
import { SessionStore } from "./session-store.ts";

const snap = (id = "s1"): Snapshot => ({
	sessionId: id, sessionFile: null, cwd: "/w", handleKind: "rpc",
	capabilities: { dialogs: "here", fork: true, clone: true, newSession: true, bash: true, export: true },
	conv: createConversation([{ role: "user", content: "hi", timestamp: 1 }]),
	state: { model: null, thinkingLevel: "medium", isStreaming: false, isCompacting: false, sessionId: id, messageCount: 1, pendingMessageCount: 0, autoCompactionEnabled: true },
	stats: null, models: [], thinkingLevels: ["off"], commands: [], dialogs: [], statuses: {}, widgets: {},
});

describe("SessionStore", () => {
	it("shows file history until a snapshot arrives, then goes live", () => {
		const s = new SessionStore("s1");
		expect(s.status).toBe("loading");
		s.setHistory({ messages: [{ role: "user", content: "from disk" }], live: false, cwd: "/w", name: "katsu" });
		expect(s.status).toBe("history");
		expect(s.conv.messages).toHaveLength(1);
		expect(s.nameHint).toBe("katsu");
		s.apply({ type: "snapshot", snapshot: snap() });
		expect(s.status).toBe("live");
		s.setHistory({ messages: [], live: true, cwd: "/w" }); // late history must not clobber live state
		expect(s.conv.messages).toHaveLength(1);
	});
	it("applies live events, meta, and dialogs", () => {
		const s = new SessionStore("s1");
		s.apply({ type: "snapshot", snapshot: snap() });
		s.apply({ type: "event", event: { type: "agent_start" } });
		s.apply({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" } } });
		expect(s.conv.partial?.content).toEqual([{ type: "text", text: "Hi" }]);
		const m = snap();
		s.apply({ type: "meta", state: { ...m.state, thinkingLevel: "high" }, stats: null, statuses: { lsp: "LSP Inactive" }, widgets: {}, thinkingLevels: ["off", "high"] });
		expect(s.snapshot?.state.thinkingLevel).toBe("high");
		expect(s.snapshot?.statuses).toEqual({ lsp: "LSP Inactive" });
		s.apply({ type: "dialog", dialog: { id: "d1", method: "confirm", title: "Allow rm?" } });
		expect(s.dialogs.map((d) => d.id)).toEqual(["d1"]);
		s.apply({ type: "dialog_closed", id: "d1" });
		expect(s.dialogs).toEqual([]);
	});
	it("follows a session change to a new id", () => {
		const s = new SessionStore("s1");
		const seen: string[] = [];
		s.addEventListener("snapshot", () => seen.push(s.id));
		s.apply({ type: "snapshot", snapshot: snap("s2") });
		expect(seen).toEqual(["s2"]);
	});
	it("falls back to history when the process goes away, keeping the conversation", () => {
		const s = new SessionStore("s1");
		s.apply({ type: "snapshot", snapshot: snap() });
		s.apply({ type: "handle_gone", reason: "exit", stderr: "boom" });
		expect(s.status).toBe("history");
		expect(s.snapshot).toBe(null);
		expect(s.lastExit).toBe("boom");
		expect(s.conv.messages).toHaveLength(1);
	});
	it("stays 'starting' through a detached message, and emits notices", () => {
		const s = new SessionStore("s1");
		const notices: StreamMessage[] = [];
		s.addEventListener("notice", (e) => notices.push((e as CustomEvent<StreamMessage>).detail));
		s.markStarting();
		s.apply({ type: "detached" });
		expect(s.status).toBe("starting");
		s.apply({ type: "notify", message: "picked blue", level: "info" });
		expect(notices).toEqual([{ type: "notify", message: "picked blue", level: "info" }]);
	});
});
```

`app/src/lib/list-store.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { ListMessage, SessionSummary } from "../../../shared/src/protocol.ts";
import { ListStore } from "./list-store.ts";

const s = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
	id, cwd: "/w", name: null, firstPrompt: id, userMessages: 1, model: null, contextTokens: null,
	createdAt: 0, updatedAt: 0, parentSession: null, live: false, handleKind: null, state: "idle", ...over,
});

describe("ListStore", () => {
	it("loads, applies live state, and refetches when a run finishes", async () => {
		let list = [s("a"), s("b")];
		const api = { sessions: vi.fn(async () => ({ sessions: list, home: "/home/m" })), eventsUrl: () => "events" };
		let push: (m: ListMessage) => void = () => {};
		const open = vi.fn((_url: string, onMessage: (m: ListMessage) => void) => {
			push = onMessage;
			return { close() {} };
		});
		const store = new ListStore(api, open as never);
		store.start();
		await vi.waitFor(() => expect(store.loaded).toBe(true));
		expect(store.sessions.map((x) => x.id)).toEqual(["a", "b"]);
		push({ type: "session_state", sessionId: "a", live: true, handleKind: "rpc", state: "running" });
		expect(store.sessions[0]).toMatchObject({ live: true, state: "running" });
		list = [s("a", { name: "renamed after run" }), s("b")];
		push({ type: "session_state", sessionId: "a", live: true, handleKind: "rpc", state: "idle" });
		await vi.waitFor(() => expect(store.sessions[0].name).toBe("renamed after run"));
		store.stop();
	});
	it("keeps the last list and reports the error when the hub is unreachable", async () => {
		const api = { sessions: vi.fn(async () => { throw new Error("Can't reach the hub. Is Tailscale connected?"); }), eventsUrl: () => "events" };
		const store = new ListStore(api, (() => ({ close() {} })) as never);
		await store.refresh();
		expect(store.error).toBe("Can't reach the hub. Is Tailscale connected?");
		expect(store.loaded).toBe(true);
	});
});
```

Run: `npm test -w app`
Expected: FAIL for the four new files, because the modules don't exist.

- [ ] **Step 2: Implement the data layer**

`app/src/lib/toast.ts`:

```ts
export type ToastLevel = "info" | "warning" | "error";
export interface ToastDetail {
	message: string;
	level: ToastLevel;
}

export function toast(message: string, level: ToastLevel = "info"): void {
	window.dispatchEvent(new CustomEvent<ToastDetail>("pi-toast", { detail: { message, level } }));
}
```

`app/src/lib/api.ts`:

```ts
import type { AgentMessage, AppCommand, CommandResult, HealthInfo, SessionSummary } from "../../../shared/src/protocol.ts";

export class HubError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface HistoryResponse {
	messages: AgentMessage[];
	live: boolean;
	cwd: string;
	name?: string | null;
	error?: string | null;
}

export class HubApi {
	readonly base: string;

	constructor(base: string) {
		this.base = base.replace(/\/+$/, "");
	}

	private async req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		} catch {
			throw new HubError(0, "Can't reach the hub. Is Tailscale connected?");
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new HubError(res.status, (data as { error?: string }).error ?? `The hub answered ${res.status}.`);
		return data as T;
	}

	health() {
		return this.req<HealthInfo>("GET", "/api/health");
	}
	sessions() {
		return this.req<{ sessions: SessionSummary[]; home: string }>("GET", "/api/sessions");
	}
	cwds() {
		return this.req<{ cwds: string[]; home: string }>("GET", "/api/cwds");
	}
	createSession(cwd: string) {
		return this.req<{ sessionId: string }>("POST", "/api/sessions", { cwd });
	}
	history(id: string) {
		return this.req<HistoryResponse>("GET", `/api/sessions/${encodeURIComponent(id)}/history`);
	}
	command(id: string, cmd: AppCommand) {
		return this.req<{ result: CommandResult; sessionId: string }>("POST", `/api/sessions/${encodeURIComponent(id)}/commands`, cmd);
	}
	close(id: string) {
		return this.req<{ ok: true }>("POST", `/api/sessions/${encodeURIComponent(id)}/close`, {});
	}
	streamUrl(id: string) {
		return `${this.base}/api/sessions/${encodeURIComponent(id)}/stream`;
	}
	eventsUrl() {
		return `${this.base}/api/events`;
	}

	// Cross-origin navigations carry no Origin header, so the hub would refuse a
	// plain link; fetch the file and hand it to the browser as a download.
	async downloadExport(name: string): Promise<void> {
		const res = await fetch(`${this.base}/api/exports/${encodeURIComponent(name)}`).catch(() => null);
		if (!res?.ok) throw new HubError(res?.status ?? 0, "The export couldn't be downloaded.");
		const url = URL.createObjectURL(await res.blob());
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}
}
```

`app/src/lib/stream.ts`:

```ts
export type StreamStatus = "connecting" | "open" | "reconnecting";

export interface EventSourceLike {
	onopen: ((e: Event) => void) | null;
	onmessage: ((e: MessageEvent) => void) | null;
	onerror: ((e: Event) => void) | null;
	close(): void;
}
export type EventSourceCtor = new (url: string) => EventSourceLike;

// EventSource retries on its own, but without backoff; we close it on error
// and reconnect ourselves (1s doubling to 30s, reset after a good connection).
export function openStream<T>(
	url: string,
	onMessage: (m: T) => void,
	onStatus: (s: StreamStatus) => void,
	ES: EventSourceCtor = EventSource,
	schedule: typeof setTimeout = setTimeout,
): { close(): void } {
	let es: EventSourceLike | null = null;
	let delay = 1000;
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const connect = () => {
		if (closed) return;
		const source = new ES(url);
		es = source;
		source.onopen = () => {
			delay = 1000;
			onStatus("open");
		};
		source.onmessage = (e) => {
			try {
				onMessage(JSON.parse(e.data) as T);
			} catch {}
		};
		source.onerror = () => {
			source.close();
			if (es === source) es = null;
			if (closed) return;
			onStatus("reconnecting");
			timer = schedule(connect, delay);
			delay = Math.min(delay * 2, 30_000);
		};
	};
	onStatus("connecting");
	connect();
	return {
		close() {
			closed = true;
			clearTimeout(timer);
			es?.close();
		},
	};
}
```

`app/src/lib/session-store.ts`:

```ts
// One open session in the app: file history first, then the hub's snapshot,
// then live events folded with the same reducer the hub uses.

import type { Conversation, Dialog, Snapshot, StreamMessage } from "../../../shared/src/protocol.ts";
import { applyEvent, createConversation } from "../../../shared/src/reducer.ts";
import type { HistoryResponse } from "./api.ts";
import type { StreamStatus } from "./stream.ts";

export type SessionStatus = "loading" | "history" | "starting" | "live" | "reconnecting";

export class SessionStore extends EventTarget {
	id: string;
	snapshot: Snapshot | null = null;
	conv: Conversation = createConversation();
	status: SessionStatus = "loading";
	dialogs: Dialog[] = [];
	dialogSeenAt = new Map<string, number>();
	cwdHint: string | null = null;
	nameHint: string | null = null;
	lastExit: string | null = null;

	constructor(id: string) {
		super();
		this.id = id;
	}

	setHistory(h: HistoryResponse): void {
		this.cwdHint = h.cwd;
		this.nameHint = h.name ?? null;
		this.lastExit = h.error ?? null;
		if (this.snapshot) return;
		this.conv = createConversation(h.messages);
		if (this.status === "loading") this.status = "history";
		this.changed();
	}

	markStarting(): void {
		if (this.snapshot) return;
		this.status = "starting";
		this.changed();
	}

	cancelStarting(): void {
		if (this.status === "starting") this.status = "history";
		this.changed();
	}

	setStreamStatus(s: StreamStatus): void {
		if (s === "reconnecting" && this.snapshot) this.status = "reconnecting";
		this.changed();
	}

	apply(msg: StreamMessage): void {
		switch (msg.type) {
			case "snapshot":
				this.snapshot = msg.snapshot;
				this.id = msg.snapshot.sessionId;
				this.conv = msg.snapshot.conv;
				this.dialogs = [...msg.snapshot.dialogs];
				for (const d of this.dialogs) if (!this.dialogSeenAt.has(d.id)) this.dialogSeenAt.set(d.id, Date.now());
				this.cwdHint = msg.snapshot.cwd;
				this.status = "live";
				this.lastExit = null;
				this.dispatchEvent(new Event("snapshot"));
				break;
			case "detached":
				this.snapshot = null;
				this.dialogs = [];
				if (this.status !== "starting") this.status = "history";
				break;
			case "event":
				applyEvent(this.conv, msg.event);
				break;
			case "meta":
				if (this.snapshot) Object.assign(this.snapshot, { state: msg.state, stats: msg.stats, statuses: msg.statuses, widgets: msg.widgets, thinkingLevels: msg.thinkingLevels });
				break;
			case "dialog":
				this.dialogs = [...this.dialogs.filter((d) => d.id !== msg.dialog.id), msg.dialog];
				this.dialogSeenAt.set(msg.dialog.id, Date.now());
				break;
			case "dialog_closed":
				this.dialogs = this.dialogs.filter((d) => d.id !== msg.id);
				break;
			case "handle_gone":
				this.snapshot = null;
				this.dialogs = [];
				this.status = "history";
				this.lastExit = msg.reason === "exit" ? msg.stderr || "pi stopped unexpectedly." : null;
				break;
			default:
				this.dispatchEvent(new CustomEvent<StreamMessage>("notice", { detail: msg }));
		}
		this.changed();
	}

	private changed(): void {
		this.dispatchEvent(new Event("change"));
	}
}
```

`app/src/lib/list-store.ts`:

```ts
import type { ListMessage, SessionSummary } from "../../../shared/src/protocol.ts";
import type { HubApi } from "./api.ts";
import { openStream } from "./stream.ts";

const CACHE_KEY = "pi-web:sessions";

function readCache(): { sessions: SessionSummary[]; home: string } | null {
	try {
		return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
	} catch {
		return null;
	}
}

function writeCache(v: { sessions: SessionSummary[]; home: string }): void {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify(v));
	} catch {}
}

export class ListStore extends EventTarget {
	sessions: SessionSummary[] = [];
	home = "";
	error: string | null = null;
	loaded = false;
	private api: Pick<HubApi, "sessions" | "eventsUrl">;
	private open: typeof openStream;
	private stream: { close(): void } | null = null;
	private timer: ReturnType<typeof setInterval> | undefined;
	private onVisible = () => {
		if (document.visibilityState === "visible") void this.refresh();
	};

	constructor(api: Pick<HubApi, "sessions" | "eventsUrl">, open: typeof openStream = openStream) {
		super();
		this.api = api;
		this.open = open;
		const cached = readCache();
		if (cached) {
			this.sessions = cached.sessions;
			this.home = cached.home;
		}
	}

	start(): void {
		void this.refresh();
		this.stream = this.open<ListMessage>(this.api.eventsUrl(), (m) => this.apply(m), () => {});
		this.timer = setInterval(() => void this.refresh(), 30_000);
		if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
	}

	stop(): void {
		this.stream?.close();
		clearInterval(this.timer);
		if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
	}

	async refresh(): Promise<void> {
		try {
			const r = await this.api.sessions();
			this.sessions = r.sessions;
			this.home = r.home;
			this.error = null;
			writeCache(r);
		} catch (e) {
			this.error = (e as Error).message;
		}
		this.loaded = true;
		this.changed();
	}

	apply(m: ListMessage): void {
		if (m.type === "session_list_changed") return void this.refresh();
		const s = this.sessions.find((x) => x.id === m.sessionId);
		if (!s) {
			if (m.live) void this.refresh();
			return;
		}
		const finished = s.state === "running" && m.state !== "running";
		Object.assign(s, { live: m.live, handleKind: m.handleKind, state: m.state });
		this.changed();
		if (finished) void this.refresh(); // pick up the new title, time and context size
	}

	private changed(): void {
		this.dispatchEvent(new Event("change"));
	}
}
```

- [ ] **Step 3: Run the tests and typecheck to verify they pass**

Run: `npm test -w app && npm run typecheck -w app`
Expected: all tests pass and tsc exits 0.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib
git commit -m "feat(app): hub API client, SSE with backoff, session and list stores

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: App shell: layout, sidebar, settings, new session, toasts

Lit components can't be unit-tested in this repo's Node test environment, because there is no DOM shim. They are checked by typecheck, by a manual run against the dev hub in each task, and by the Playwright smoke tests in Task 16. All logic worth unit-testing already lives in `lib/` (Tasks 10–11).

**Files:**
- Modify: `app/src/components/pi-app.ts` (replaces the Task 9 placeholder)
- Create: `app/src/components/pi-sidebar.ts`, `app/src/components/pi-settings.ts`, `app/src/components/pi-new-session.ts`, `app/src/components/pi-toasts.ts`

**Interfaces:**
- Consumes: `HubApi`, `ListStore`, `parseRoute`/`hrefFor`, `getHubUrl`/`setHubUrl`/`normalizeHubUrl`/`getTheme`/`setTheme`, `groupSessions`/`sessionTitle`/`relativeTime`/`formatTokens`/`abbreviateCwd`, `toast`, and `sharedStyles`.
- Produces: the custom elements `<pi-app>`, `<pi-sidebar .list .currentId>`, `<pi-settings>` (fires `pi-hub-changed`), `<pi-new-session .api .cwd>` and `<pi-toasts>`.
- Events `pi-app` listens for, all bubbling and composed:
  - `pi-open-nav` opens the mobile sidebar.
  - `pi-route-replaced` carries a `detail: Route` and updates the route without a reload.
  - `pi-hub-changed`
- `pi-app` renders `<pi-session .api .sessionId .home>` for `#/s/:id`. That element arrives in Task 15, and until then the route shows an empty main pane.

- [ ] **Step 1: Write `pi-toasts`**

`app/src/components/pi-toasts.ts`:

```ts
import { LitElement, css, html } from "lit";
import type { ToastDetail } from "../lib/toast.ts";
import { sharedStyles } from "../styles/shared.ts";

interface Item extends ToastDetail {
	id: number;
}

export class PiToasts extends LitElement {
	static properties = { items: { state: true } };
	declare items: Item[];
	private n = 0;

	static styles = [
		sharedStyles,
		css`
			.stack { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(96px + env(safe-area-inset-bottom)); z-index: 50; display: grid; gap: 8px; width: min(92vw, 460px); pointer-events: none; }
			.toast { pointer-events: auto; background: var(--text); color: var(--bg); border-radius: var(--radius); padding: 9px 12px; font-size: 0.9rem; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25); cursor: pointer; overflow-wrap: anywhere; white-space: pre-wrap; }
			.toast.warning { border-left: 4px solid var(--accent); }
			.toast.error { border-left: 4px solid var(--primary); }
		`,
	];

	constructor() {
		super();
		this.items = [];
	}

	private onToast = (e: Event) => {
		const d = (e as CustomEvent<ToastDetail>).detail;
		const id = ++this.n;
		this.items = [...this.items, { ...d, id }].slice(-4);
		setTimeout(() => this.dismiss(id), d.level === "error" ? 8000 : 4000);
	};

	connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener("pi-toast", this.onToast);
	}

	disconnectedCallback(): void {
		window.removeEventListener("pi-toast", this.onToast);
		super.disconnectedCallback();
	}

	private dismiss(id: number): void {
		this.items = this.items.filter((t) => t.id !== id);
	}

	render() {
		return html`<div class="stack" role="status" aria-live="polite">
			${this.items.map((t) => html`<div class="toast ${t.level}" @click=${() => this.dismiss(t.id)}>${t.message}</div>`)}
		</div>`;
	}
}
customElements.define("pi-toasts", PiToasts);
```

- [ ] **Step 2: Write `pi-sidebar`**

`app/src/components/pi-sidebar.ts`:

```ts
import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import type { SessionSummary } from "../../../shared/src/protocol.ts";
import { formatTokens, groupSessions, relativeTime, sessionTitle } from "../lib/format.ts";
import type { ListStore } from "../lib/list-store.ts";
import { hrefFor } from "../lib/route.ts";
import { sharedStyles } from "../styles/shared.ts";

function stateLabel(s: SessionSummary): string | null {
	if (s.state === "running") return "running";
	if (s.state === "needs_you") return "needs you";
	if (s.state === "error") return "stopped with an error";
	if (s.live) return s.handleKind === "bridge" ? "open in terminal" : "open";
	return null;
}

function dotClass(s: SessionSummary): string {
	if (s.state === "running" || s.state === "needs_you" || s.state === "error") return s.state;
	return s.live ? "live" : "";
}

export class PiSidebar extends LitElement {
	static properties = { list: { attribute: false }, currentId: { attribute: false }, query: { state: true } };
	declare list: ListStore | null;
	declare currentId: string | null;
	declare query: string;
	private bound: ListStore | null = null;

	static styles = [
		sharedStyles,
		css`
			:host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
			.top { display: flex; justify-content: space-between; align-items: baseline; padding: 16px 16px 10px; }
			.brand { font-family: var(--font-display); font-size: 1.6rem; letter-spacing: 0.1em; color: var(--text); }
			nav { display: flex; gap: 14px; font-family: var(--font-quote); font-weight: 500; font-size: 0.9rem; }
			.search { padding: 0 16px 8px; }
			.search input { width: 100%; border-color: var(--line); padding: 5px 9px; }
			.offline { margin: 4px 16px 8px; font-size: 0.8rem; color: var(--primary); }
			.retry { color: var(--accent); margin-left: 6px; }
			.groups { overflow-y: auto; flex: 1; padding-bottom: calc(16px + env(safe-area-inset-bottom)); overscroll-behavior: contain; }
			h2.label { margin: 0; padding: 12px 16px 4px; font-weight: 400; }
			.row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; column-gap: 8px; row-gap: 2px; align-items: baseline; padding: 7px 16px 7px 14px; border-left: 2px solid transparent; color: var(--text); }
			.row:hover { background: var(--panel); }
			.row.cur { background: var(--panel); border-left-color: var(--accent); }
			.t { font-weight: 500; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.ago { font-size: 0.72rem; color: var(--muted); font-variant-numeric: tabular-nums; }
			.d { grid-column: 2 / 4; font-size: 0.72rem; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.none { padding: 16px; color: var(--text-2); font-size: 0.9rem; }
		`,
	];

	constructor() {
		super();
		this.list = null;
		this.currentId = null;
		this.query = "";
	}

	private onChange = () => this.requestUpdate();

	willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("list") && this.bound !== this.list) {
			this.bound?.removeEventListener("change", this.onChange);
			this.bound = this.list;
			this.bound?.addEventListener("change", this.onChange);
		}
	}

	disconnectedCallback(): void {
		this.bound?.removeEventListener("change", this.onChange);
		this.bound = null;
		super.disconnectedCallback();
	}

	render() {
		const list = this.list;
		const groups = list ? groupSessions(list.sessions, this.query, list.home) : [];
		return html`
			<div class="top">
				<a class="brand" href="#/" aria-label="pi home"><span class="u on">pi</span></a>
				<nav><a class="u" href="#/new">+ new</a><a class="u" href="#/settings">settings</a></nav>
			</div>
			<label class="search">
				<span class="sr-only">Search sessions</span>
				<input type="search" placeholder="search sessions" .value=${this.query} @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)} />
			</label>
			${list?.error ? html`<div class="offline" role="status">${list.error}<button class="retry u" @click=${() => list.refresh()}>retry</button></div>` : nothing}
			<div class="groups">
				${groups.map((g) => html`<section><h2 class="label">${g.label}</h2>${g.sessions.map((s) => this.row(s))}</section>`)}
				${list?.loaded && groups.length === 0 ? html`<p class="none">${this.query ? "No sessions match." : html`No sessions yet. <a href="#/new">Start one</a>.`}</p>` : nothing}
			</div>
		`;
	}

	private row(s: SessionSummary) {
		const cur = s.id === this.currentId;
		const model = s.model?.split("/").pop() ?? null;
		const meta = [stateLabel(s), model, s.contextTokens != null ? `${formatTokens(s.contextTokens)} context` : null].filter(Boolean).join(" · ");
		return html`<a class="row ${cur ? "cur" : ""}" href=${hrefFor({ name: "session", id: s.id })} aria-current=${cur ? "page" : "false"}>
			<span class="dot ${dotClass(s)}" aria-hidden="true"></span>
			<span class="t">${sessionTitle(s)}</span>
			<span class="ago">${relativeTime(s.updatedAt)}</span>
			<span class="d">${meta || `${s.userMessages} prompt${s.userMessages === 1 ? "" : "s"}`}</span>
		</a>`;
	}
}
customElements.define("pi-sidebar", PiSidebar);
```

- [ ] **Step 3: Write `pi-settings`**

`app/src/components/pi-settings.ts`:

```ts
import { LitElement, css, html, nothing } from "lit";
import { HubApi } from "../lib/api.ts";
import { type ThemePref, getHubUrl, getTheme, normalizeHubUrl, setHubUrl, setTheme } from "../lib/settings.ts";
import { sharedStyles } from "../styles/shared.ts";

export class PiSettings extends LitElement {
	static properties = { url: { state: true }, status: { state: true }, checking: { state: true }, theme: { state: true } };
	declare url: string;
	declare status: { ok: boolean; text: string } | null;
	declare checking: boolean;
	declare theme: ThemePref;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; overflow-y: auto; height: 100%; }
			.wrap { max-width: 560px; margin: 0 auto; padding: calc(24px + env(safe-area-inset-top)) 18px 40px; display: grid; gap: 14px; }
			h1 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.1em; font-size: 2rem; margin: 0; }
			h2 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.08em; font-size: 1.2rem; margin: 18px 0 0; }
			label { font-family: var(--font-display); letter-spacing: 0.06em; }
			.hint { color: var(--text-2); font-size: 0.85rem; margin: 0; }
			code { font-family: var(--font-mono); font-size: 0.85em; }
			form { display: grid; gap: 8px; }
			.row { display: flex; gap: 8px; }
			.row input { flex: 1; min-width: 0; }
			.status.ok { color: var(--success); }
			.status.bad { color: var(--primary); }
			.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; width: max-content; }
			.seg button { padding: 5px 14px; font-size: 0.9rem; }
			.seg button.on { background: var(--text); color: var(--bg); }
			a.back { font-family: var(--font-quote); }
		`,
	];

	constructor() {
		super();
		this.url = getHubUrl() ?? "";
		this.status = null;
		this.checking = false;
		this.theme = getTheme();
	}

	private async connect(e: Event): Promise<void> {
		e.preventDefault();
		let base: string;
		try {
			base = normalizeHubUrl(this.url);
		} catch (err) {
			this.status = { ok: false, text: (err as Error).message };
			return;
		}
		this.checking = true;
		try {
			const h = await new HubApi(base).health();
			setHubUrl(base);
			this.url = base;
			this.status = { ok: true, text: `Connected as ${h.login} (hub ${h.hubVersion}).` };
			this.dispatchEvent(new CustomEvent("pi-hub-changed", { bubbles: true, composed: true }));
			location.hash = "#/";
		} catch (err) {
			this.status = { ok: false, text: (err as Error).message };
		} finally {
			this.checking = false;
		}
	}

	render() {
		return html`<div class="wrap">
			<a class="back u" href="#/">← sessions</a>
			<h1>settings</h1>
			<form @submit=${this.connect}>
				<label for="hub">hub address</label>
				<p class="hint">The tailnet address of the pi-web hub on spark, for example <code>spark-713a.tail9274fa.ts.net:7878</code>.</p>
				<div class="row">
					<input id="hub" .value=${this.url} @input=${(e: Event) => (this.url = (e.target as HTMLInputElement).value)} placeholder="spark-713a.tail9274fa.ts.net:7878" autocomplete="off" autocapitalize="off" spellcheck="false" />
					<button class="btn" ?disabled=${this.checking}>${this.checking ? "checking…" : "connect"}</button>
				</div>
				${this.status ? html`<p class="status ${this.status.ok ? "ok" : "bad"}" role="status">${this.status.text}</p>` : nothing}
			</form>
			<h2>theme</h2>
			<div class="seg" role="radiogroup" aria-label="Theme">
				${(["system", "light", "dark"] as const).map(
					(t) => html`<button role="radio" aria-checked=${this.theme === t ? "true" : "false"} class=${this.theme === t ? "on" : ""} @click=${() => {
						setTheme(t);
						this.theme = t;
					}}>${t}</button>`,
				)}
			</div>
			<h2>install</h2>
			<p class="hint">On iPhone or iPad, open this page in Safari and choose Share → Add to Home Screen.</p>
		</div>`;
	}
}
customElements.define("pi-settings", PiSettings);
```

- [ ] **Step 4: Write `pi-new-session`**

`app/src/components/pi-new-session.ts`:

```ts
import { LitElement, css, html } from "lit";
import type { HubApi } from "../lib/api.ts";
import { abbreviateCwd } from "../lib/format.ts";
import { hrefFor } from "../lib/route.ts";
import { toast } from "../lib/toast.ts";
import { sharedStyles } from "../styles/shared.ts";

export class PiNewSession extends LitElement {
	static properties = { api: { attribute: false }, cwd: { attribute: false }, cwds: { state: true }, home: { state: true }, path: { state: true }, busy: { state: true } };
	declare api: HubApi;
	declare cwd: string | null;
	declare cwds: string[];
	declare home: string;
	declare path: string;
	declare busy: boolean;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; overflow-y: auto; height: 100%; }
			.wrap { max-width: 560px; margin: 0 auto; padding: calc(24px + env(safe-area-inset-top)) 18px 40px; }
			.menu { display: none; font-size: 1.4rem; margin-bottom: 8px; }
			h1 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.1em; font-size: 2rem; margin: 0 0 18px; }
			form { display: grid; gap: 10px; }
			.folders { display: flex; flex-wrap: wrap; gap: 6px; }
			.folder { border: 1px solid var(--line); border-radius: var(--radius); padding: 4px 10px; font-family: var(--font-mono); font-size: 0.85rem; color: var(--text-2); }
			.folder.on { border-color: var(--accent); color: var(--text); background: color-mix(in srgb, var(--accent), transparent 85%); }
			input { width: 100%; font-family: var(--font-mono); }
			.btn { justify-self: start; }
			.hint { color: var(--text-2); font-size: 0.85rem; margin: 0; }
			@media (max-width: 899px) { .menu { display: inline-block; } }
		`,
	];

	constructor() {
		super();
		this.cwd = null;
		this.cwds = [];
		this.home = "";
		this.path = "";
		this.busy = false;
	}

	connectedCallback(): void {
		super.connectedCallback();
		if (this.cwd) this.path = this.cwd;
		this.api
			.cwds()
			.then((r) => {
				this.cwds = r.cwds;
				this.home = r.home;
				if (!this.path) this.path = r.cwds[0] ?? r.home;
			})
			.catch((e: Error) => toast(e.message, "error"));
	}

	private async start(e: Event): Promise<void> {
		e.preventDefault();
		const cwd = this.path.trim();
		if (!cwd || this.busy) return;
		this.busy = true;
		try {
			const { sessionId } = await this.api.createSession(cwd);
			location.hash = hrefFor({ name: "session", id: sessionId });
		} catch (err) {
			toast((err as Error).message, "error");
		} finally {
			this.busy = false;
		}
	}

	render() {
		return html`<div class="wrap">
			<button class="menu" aria-label="Open sessions" @click=${() => this.dispatchEvent(new CustomEvent("pi-open-nav", { bubbles: true, composed: true }))}>☰</button>
			<h1>new session</h1>
			<form @submit=${this.start}>
				${this.cwds.length ? html`<span class="label">recent folders</span>
					<div class="folders">${this.cwds.map((c) => html`<button type="button" class="folder ${c === this.path ? "on" : ""}" @click=${() => (this.path = c)}>${abbreviateCwd(c, this.home)}</button>`)}</div>` : ""}
				<label class="label" for="path">folder path</label>
				<input id="path" aria-label="Folder path" .value=${this.path} @input=${(e: Event) => (this.path = (e.target as HTMLInputElement).value)} placeholder="~/workspace/project" autocapitalize="off" autocomplete="off" spellcheck="false" />
				<button class="btn" type="submit" ?disabled=${this.busy || !this.path.trim()}>${this.busy ? "starting pi…" : "start session"}</button>
				<p class="hint">pi starts in this folder. Pick the model once it's running.</p>
			</form>
		</div>`;
	}
}
customElements.define("pi-new-session", PiNewSession);
```

- [ ] **Step 5: Replace `pi-app` with the real shell**

`app/src/components/pi-app.ts`:

```ts
import { LitElement, css, html } from "lit";
import { HubApi } from "../lib/api.ts";
import { ListStore } from "../lib/list-store.ts";
import { type Route, hrefFor, parseRoute } from "../lib/route.ts";
import { getHubUrl } from "../lib/settings.ts";
import { sharedStyles } from "../styles/shared.ts";
import "./pi-new-session.ts";
import "./pi-settings.ts";
import "./pi-sidebar.ts";
import "./pi-toasts.ts";

export class PiApp extends LitElement {
	static properties = { route: { state: true }, navOpen: { state: true }, api: { state: true }, list: { state: true } };
	declare route: Route;
	declare navOpen: boolean;
	declare api: HubApi | null;
	declare list: ListStore | null;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; height: 100%; }
			.layout { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); height: 100vh; height: 100dvh; }
			.sidebar { border-right: 1px solid var(--line); min-width: 0; min-height: 0; background: var(--bg); padding-top: env(safe-area-inset-top); }
			.main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
			.main > * { flex: 1; min-height: 0; }
			.overlay { display: none; }
			.empty { margin: auto; flex: none; text-align: center; padding: 24px; color: var(--text-2); }
			.empty h1 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.1em; font-size: 3rem; color: var(--text); margin: 0 0 10px; }
			.empty .menu { display: none; }
			@media (max-width: 899px) {
				.layout { grid-template-columns: minmax(0, 1fr); }
				.sidebar { position: fixed; inset: 0 auto 0 0; width: min(85vw, 360px); z-index: 20; transform: translateX(-100%); transition: transform 0.25s ease; box-shadow: 2px 0 12px rgba(0, 0, 0, 0.2); }
				.nav-open .sidebar { transform: none; }
				.overlay { display: block; position: fixed; inset: 0; background: var(--overlay); z-index: 10; opacity: 0; pointer-events: none; transition: opacity 0.25s; }
				.nav-open .overlay { opacity: 1; pointer-events: auto; }
				.empty .menu { display: inline-block; font-size: 1.4rem; margin-bottom: 12px; }
			}
		`,
	];

	constructor() {
		super();
		this.route = parseRoute(location.hash);
		this.navOpen = false;
		this.api = null;
		this.list = null;
	}

	private onHash = () => {
		this.route = parseRoute(location.hash);
		this.navOpen = false;
	};
	private onOpenNav = () => {
		this.navOpen = true;
	};
	private onRouteReplaced = (e: Event) => {
		this.route = (e as CustomEvent<Route>).detail;
	};

	connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener("hashchange", this.onHash);
		this.addEventListener("pi-open-nav", this.onOpenNav);
		this.addEventListener("pi-route-replaced", this.onRouteReplaced);
		this.connectHub();
	}

	disconnectedCallback(): void {
		window.removeEventListener("hashchange", this.onHash);
		this.list?.stop();
		super.disconnectedCallback();
	}

	private connectHub = () => {
		this.list?.stop();
		const url = getHubUrl();
		if (!url) {
			this.api = null;
			this.list = null;
			if (this.route.name !== "settings") location.hash = hrefFor({ name: "settings" });
			return;
		}
		this.api = new HubApi(url);
		this.list = new ListStore(this.api);
		this.list.start();
	};

	render() {
		const r = this.route;
		return html`
			<div class="layout ${this.navOpen ? "nav-open" : ""}">
				<aside class="sidebar" aria-label="Sessions">
					<pi-sidebar .list=${this.list} .currentId=${r.name === "session" ? r.id : null}></pi-sidebar>
				</aside>
				<div class="overlay" @click=${() => (this.navOpen = false)}></div>
				<main class="main">${this.renderMain(r)}</main>
			</div>
			<pi-toasts></pi-toasts>
		`;
	}

	private renderMain(r: Route) {
		if (!this.api || r.name === "settings") return html`<pi-settings @pi-hub-changed=${this.connectHub}></pi-settings>`;
		if (r.name === "session") return html`<pi-session .api=${this.api} .sessionId=${r.id} .home=${this.list?.home ?? ""}></pi-session>`;
		if (r.name === "new") return html`<pi-new-session .api=${this.api} .cwd=${r.cwd ?? null}></pi-new-session>`;
		return html`<div class="empty">
			<button class="menu" aria-label="Open sessions" @click=${this.onOpenNav}>☰</button>
			<h1><span class="u on">pi</span></h1>
			<p>Pick a session, or <a class="u" href="#/new">start a new one</a>.</p>
		</div>`;
	}
}
customElements.define("pi-app", PiApp);
```

- [ ] **Step 6: Typecheck and try it against the dev hub**

Run:
```bash
npm run typecheck -w app
npm run dev -w hub > /tmp/hub.log 2>&1 &
npm run dev -w app > /tmp/vite.log 2>&1 &
sleep 3
curl -s -H 'Origin: http://localhost:5173' localhost:5173/api/sessions | head -c 300; echo
```
Expected: tsc exits 0, and the curl, which goes through Vite's proxy, prints Michael's sessions as JSON.

Then ask Michael to look at the result, since the agent's terminal is on spark. He runs `ssh -L 5173:localhost:5173 spark-713a` from the Mac and opens http://localhost:5173. He should see:
- the sidebar with the `pi` wordmark and search, and sessions grouped by folder (for example `~`) with relative times
- "+ new" opening the folder picker
- settings showing "Connected as dev@local (hub 0.1.0)." after **connect**
- on a narrow window, the sidebar sliding in from ☰

Stop both servers: `pkill -f "vite"; pkill -f "src/main.ts"`.

- [ ] **Step 7: Commit**

```bash
git add app/src/components
git commit -m "feat(app): shell with sidebar, settings, new-session picker and toasts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Conversation rendering and session header

**Files:**
- Create: `app/src/render/messages.ts`, `app/src/components/pi-messages.ts`, `app/src/components/pi-header.ts`

**Interfaces:**
- Consumes: `Conversation`/`AgentMessage`/`ContentBlock`/`ToolRun` (shared), the `format.ts` helpers, `renderMarkdown`, and `SessionStore`.
- Produces:
  - `renderConversation(conv: Conversation): TemplateResult` and `messageStyles` (Lit `CSSResult`)
  - `<pi-messages .conv .version>`. The parent must bump `version` on every store change, because `conv` is mutated in place.
  - `<pi-header .store .version .heading>`, which fires `pi-open-nav` and `pi-open-sheet` (detail `"model" | "stats"`). Its model button has `aria-label="Model <name>"` and its stats button has `aria-label="Session stats"`.
  - `headerStatus(store: SessionStore): string | null`

- [ ] **Step 1: Write the message renderer**

`app/src/render/messages.ts`:

```ts
import { type TemplateResult, css, html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AgentMessage, ContentBlock, Conversation, ToolRun } from "../../../shared/src/protocol.ts";
import { blocksText, formatTokens, parseArgsRaw, summarizeToolArgs, truncateOutput, wordCount } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";

type ToolCall = Extract<ContentBlock, { type: "toolCall" }>;
type Results = Map<string, AgentMessage>;

export function renderConversation(conv: Conversation): TemplateResult {
	const results: Results = new Map();
	for (const m of conv.messages) if (m.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, m);
	return html`${conv.messages.map((m) => renderMessage(m, results, conv.tools))}${conv.partial ? renderAssistant(conv.partial, results, conv.tools, true) : nothing}`;
}

function renderMessage(m: AgentMessage, results: Results, tools: Record<string, ToolRun>) {
	switch (m.role) {
		case "user":
			return renderUser(m);
		case "assistant":
			return renderAssistant(m, results, tools, false);
		case "bashExecution":
			return renderBash(m);
		case "compactionSummary":
			return html`<details class="marker"><summary>compacted · ${formatTokens(Number(m.tokensBefore ?? 0))} tokens summarized</summary><div class="md">${unsafeHTML(renderMarkdown(String(m.summary ?? "")))}</div></details>`;
		case "branchSummary":
			return html`<details class="marker"><summary>summary of another branch</summary><div class="md">${unsafeHTML(renderMarkdown(String(m.summary ?? "")))}</div></details>`;
		case "custom":
			return m.display === false ? nothing : html`<div class="custom"><span class="label">${String(m.customType ?? "extension")}</span> ${blocksText(m.content)}</div>`;
		default:
			return nothing; // toolResult renders inside its tool card; system is never shown
	}
}

function renderUser(m: AgentMessage) {
	const images = Array.isArray(m.content) ? m.content.filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image") : [];
	return html`<div class="user">${blocksText(m.content)}${
		images.length ? html`<div class="imgs">${images.map((i) => html`<img alt="attached image" src="data:${i.mimeType};base64,${i.data}" />`)}</div>` : nothing
	}</div>`;
}

function renderAssistant(m: AgentMessage, results: Results, tools: Record<string, ToolRun>, streaming: boolean) {
	const blocks = Array.isArray(m.content) ? m.content : [];
	return html`<div class="assistant">
		${blocks.map((b) => {
			if (!b) return nothing;
			if (b.type === "thinking") {
				if (b.thinking.trim()) return html`<details class="think"><summary>thinking · ${wordCount(b.thinking)} words</summary><div class="think-body">${b.thinking}</div></details>`;
				return b.redacted ? html`<div class="note">thinking (redacted)</div>` : nothing;
			}
			if (b.type === "text") return b.text.trim() ? html`<div class="md">${unsafeHTML(renderMarkdown(b.text))}</div>` : nothing;
			if (b.type === "toolCall") return renderTool(b, results.get(b.id), tools[b.id]);
			return nothing;
		})}
		${m.stopReason === "error" ? html`<div class="err" role="alert">${String(m.errorMessage ?? "The model returned an error.")}</div>` : nothing}
		${m.stopReason === "aborted" ? html`<div class="note">stopped</div>` : nothing}
		${streaming && blocks.length === 0 ? html`<div class="note">working…</div>` : nothing}
	</div>`;
}

function renderTool(call: ToolCall, result?: AgentMessage, run?: ToolRun) {
	const args = call.arguments && Object.keys(call.arguments).length ? call.arguments : parseArgsRaw(call.argsRaw);
	const done = Boolean(result) || run?.running === false;
	const isError = result ? Boolean(result.isError) : Boolean(run?.isError);
	const status = !done ? "running" : isError ? "error" : "ok";
	const output = blocksText(result?.content ?? run?.result?.content ?? run?.partialResult?.content);
	return html`<details class="tool ${status}">
		<summary>
			<span class="st" aria-label=${status}>${status === "ok" ? "✓" : status === "error" ? "✗" : html`<span class="spin"></span>`}</span>
			<span class="name">${call.name}</span>
			<code>${summarizeToolArgs(call.name, args)}</code>
		</summary>
		${Object.keys(args).length ? html`<pre class="args">${JSON.stringify(args, null, 2)}</pre>` : nothing}
		${output ? html`<pre class="out">${truncateOutput(output)}</pre>` : nothing}
	</details>`;
}

function renderBash(m: AgentMessage) {
	const ok = m.exitCode === 0;
	return html`<details class="tool ${ok ? "ok" : "error"}">
		<summary><span class="st">$</span><code>${String(m.command ?? "")}</code>${m.excludeFromContext ? html`<span class="label">not in context</span>` : nothing}</summary>
		<pre class="out">${truncateOutput(String(m.output ?? ""))}</pre>
	</details>`;
}

export const messageStyles = css`
	:host { display: grid; gap: 14px; padding: 16px 18px 28px; max-width: 760px; margin: 0 auto; width: 100%; align-content: start; }
	.user { border-left: 3px solid var(--accent); padding: 2px 0 2px 12px; font-family: var(--font-quote); white-space: pre-wrap; overflow-wrap: anywhere; }
	.imgs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
	.imgs img { max-width: 160px; max-height: 160px; border-radius: var(--radius); }
	.assistant { display: grid; gap: 8px; min-width: 0; }
	.md { overflow-wrap: anywhere; line-height: 1.6; min-width: 0; }
	.md > :first-child { margin-top: 0; }
	.md > :last-child { margin-bottom: 0; }
	.md p, .md ul, .md ol { margin: 0 0 0.7em; }
	.md h1, .md h2, .md h3, .md h4 { font-family: var(--font-display); font-weight: 600; line-height: 1.25; margin: 1em 0 0.4em; font-size: 1.1em; }
	.md pre { background: var(--code-bg); padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-family: var(--font-mono); font-size: 0.85em; }
	.md code { font-family: var(--font-mono); font-size: 0.9em; background: var(--code-bg); padding: 1px 4px; border-radius: 2px; }
	.md pre code { background: none; padding: 0; }
	.md blockquote { border-left: 3px solid var(--line); margin: 0 0 0.7em; padding-left: 12px; color: var(--text-2); }
	.md table { border-collapse: collapse; display: block; overflow-x: auto; margin-bottom: 0.7em; }
	.md th, .md td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
	details > summary { cursor: pointer; list-style: none; }
	details > summary::-webkit-details-marker { display: none; }
	.think summary { font-size: 0.82em; color: var(--muted); font-style: italic; }
	.think-body { white-space: pre-wrap; font-size: 0.85em; color: var(--text-2); border-left: 2px solid var(--line); padding-left: 10px; margin-top: 4px; }
	.tool { border: 1px solid var(--line); border-radius: var(--radius); font-size: 0.82em; min-width: 0; }
	.tool summary { display: flex; gap: 8px; align-items: center; padding: 5px 9px; background: var(--panel); min-width: 0; }
	.tool .name { font-weight: 600; flex: none; }
	.tool code { font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; color: var(--text-2); }
	.tool.ok .st { color: var(--success); font-weight: 700; }
	.tool.error .st { color: var(--primary); font-weight: 700; }
	.tool pre { margin: 0; padding: 8px 9px; font-family: var(--font-mono); font-size: 0.92em; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; color: var(--text-2); }
	.tool pre.args { border-bottom: 1px solid var(--line); }
	.spin { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--line); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -1px; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.err { color: var(--primary); font-size: 0.9em; border-left: 3px solid var(--primary); padding-left: 10px; overflow-wrap: anywhere; }
	.note { font-size: 0.8em; color: var(--muted); font-style: italic; }
	.marker { border-top: 1px dashed var(--line); padding-top: 6px; }
	.marker summary, .custom { font-size: 0.8em; color: var(--muted); }
	.marker summary { font-family: var(--font-display); letter-spacing: 0.06em; }
`;
```

- [ ] **Step 2: Write `pi-messages`**

`app/src/components/pi-messages.ts`:

```ts
import { LitElement, nothing } from "lit";
import type { Conversation } from "../../../shared/src/protocol.ts";
import { messageStyles, renderConversation } from "../render/messages.ts";
import { sharedStyles } from "../styles/shared.ts";

export class PiMessages extends LitElement {
	static properties = { conv: { attribute: false }, version: { attribute: false } };
	declare conv: Conversation | null;
	declare version: number; // bumped by the parent because conv is mutated in place
	static styles = [sharedStyles, messageStyles];

	constructor() {
		super();
		this.conv = null;
		this.version = 0;
	}

	render() {
		return this.conv ? renderConversation(this.conv) : nothing;
	}
}
customElements.define("pi-messages", PiMessages);
```

- [ ] **Step 3: Write `pi-header`**

`app/src/components/pi-header.ts`:

```ts
import { LitElement, css, html, nothing } from "lit";
import { formatCost, formatTokens } from "../lib/format.ts";
import type { SessionStore } from "../lib/session-store.ts";
import { sharedStyles } from "../styles/shared.ts";

export function headerStatus(s: SessionStore): string | null {
	switch (s.status) {
		case "loading":
			return "loading…";
		case "starting":
			return "starting pi…";
		case "reconnecting":
			return "reconnecting…";
		case "history":
			return s.lastExit ? `pi stopped: ${s.lastExit.split("\n").at(-1)}. Send a message to restart it.` : "pi isn't running for this session. Sending a message starts it.";
	}
	if (s.conv.retry) return `retrying (${s.conv.retry.attempt}/${s.conv.retry.max})…`;
	if (s.conv.compacting) return "compacting…";
	if (s.snapshot?.handleKind === "bridge") return "open in terminal";
	return null;
}

export class PiHeader extends LitElement {
	static properties = { store: { attribute: false }, version: { attribute: false }, heading: { attribute: false } };
	declare store: SessionStore | null;
	declare version: number;
	declare heading: string;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); padding-top: env(safe-area-inset-top); transition: transform 0.2s ease; }
			header { display: grid; gap: 6px; padding: 10px 18px 9px; }
			.l1 { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
			.menu { display: none; font-size: 1.2rem; line-height: 1; align-self: center; }
			h1 { font-family: var(--font-display); font-weight: 400; font-size: 1.15rem; letter-spacing: 0.02em; margin: 0; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.model { color: var(--accent); font-size: 0.8rem; white-space: nowrap; }
			.model b { font-weight: 500; }
			.l2 { display: grid; grid-template-columns: minmax(40px, 1fr) auto; gap: 10px; align-items: center; width: 100%; text-align: left; font-size: 0.72rem; color: var(--text-2); font-variant-numeric: tabular-nums; }
			.meter { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; display: block; }
			.meter i { display: block; height: 100%; background: var(--accent); transition: width 0.4s ease; }
			.meter.hot i { background: var(--primary); }
			.state { font-size: 0.72rem; color: var(--muted); font-style: italic; }
			@media (max-width: 899px) {
				header { padding: 8px 14px; }
				.menu { display: inline-block; }
				:host([tucked]) { transform: translateY(-100%); }
			}
		`,
	];

	constructor() {
		super();
		this.store = null;
		this.version = 0;
		this.heading = "";
	}

	private emit(type: string, detail?: unknown): void {
		this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
	}

	render() {
		const s = this.store;
		if (!s) return nothing;
		const snap = s.snapshot;
		const model = snap?.state.model ?? null;
		const stats = snap?.stats ?? null;
		const ctx = stats?.contextUsage;
		const pct = ctx?.percent ?? null;
		const t = stats?.tokens;
		const status = headerStatus(s);
		const nums = [
			ctx ? `${ctx.tokens == null ? "—" : formatTokens(ctx.tokens)} / ${formatTokens(ctx.contextWindow)}` : "—",
			t ? `↑${formatTokens(t.input + t.cacheRead)} ↓${formatTokens(t.output)}` : null,
			stats?.cost ? formatCost(stats.cost) : null,
		]
			.filter(Boolean)
			.join(" · ");
		return html`<header>
			<div class="l1">
				<button class="menu" aria-label="Open sessions" @click=${() => this.emit("pi-open-nav")}>☰</button>
				<h1>${this.heading}</h1>
				<button class="model u" aria-label=${`Model ${model?.name ?? "not loaded"}`} @click=${() => this.emit("pi-open-sheet", "model")}>
					${model ? html`<b>${model.name}</b> · ${snap?.state.thinkingLevel}` : "model"}
				</button>
			</div>
			<button class="l2" aria-label="Session stats" @click=${() => this.emit("pi-open-sheet", "stats")}>
				<span class="meter ${pct != null && pct >= 80 ? "hot" : ""}"><i style=${`width:${Math.min(100, Math.max(0, pct ?? 0))}%`}></i></span>
				<span>${nums}</span>
			</button>
			${status ? html`<div class="state" role="status">${status}</div>` : nothing}
		</header>`;
	}
}
customElements.define("pi-header", PiHeader);
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w app && npm test -w app`
Expected: tsc exits 0 and the unit tests still pass. These components render in Task 15. Their behavior is exercised there and in Task 16.

- [ ] **Step 5: Commit**

```bash
git add app/src
git commit -m "feat(app): conversation rendering and session header with context meter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: Composer, slash menu, and sheets

**Files:**
- Create: `app/src/components/pi-composer.ts`, `app/src/components/pi-sheet.ts`, `app/src/render/sheets.ts`

**Interfaces:**
- Consumes: `SlashItem`/`filterSlash`/`slashQuery` (Task 10), `toast`, the `format.ts` helpers, and the shared protocol types.
- Produces:
  - `<pi-composer>`:
    - properties: `.streaming`, `.items`, `.canImages`, `.rpcOnlyDisabled`, `.queue`, `.statuses`
    - methods: `setText(text)` and `restore(text, images)`
    - fires `pi-submit` (a `CustomEvent<SubmitDetail>`, where `SubmitDetail = { text: string; images: ImageInput[]; mode: PromptMode }`) and `pi-abort`
    - the textarea has `aria-label="Message"`, and the menu is `role="listbox" aria-label="Commands"`
    - Enter sends on fine-pointer devices. While streaming, the send button reads **steer**, and a 500ms press sends **followUp**.
  - `<pi-sheet open heading=…>`: a slot for the body, which fires `pi-close` on Escape, the backdrop, or ✕
  - **sheets.ts:**
    - `modelSheet(snap, { pickModel, pickThinking })` (model rows are `role="option"`)
    - `statsSheet(snap, home)`
    - `dialogSheet(dialog, seenAt, respond)` with `type DialogAnswer = { value?: string; confirmed?: boolean; cancelled?: boolean }`
    - `forkSheet(points, onFork)`
    - `sheetStyles`
  - `UNAVAILABLE_IN_TERMINAL` is a const string.

- [ ] **Step 1: Write `pi-sheet`**

`app/src/components/pi-sheet.ts`:

```ts
import { LitElement, css, html, nothing } from "lit";
import { sharedStyles } from "../styles/shared.ts";

// Bottom sheet on phones, centered panel on wide screens. Content is slotted,
// so its styles live with whoever renders it (pi-session).
export class PiSheet extends LitElement {
	static properties = { open: { type: Boolean, reflect: true }, heading: { type: String } };
	declare open: boolean;
	declare heading: string;

	static styles = [
		sharedStyles,
		css`
			.scrim { position: fixed; inset: 0; background: var(--overlay); z-index: 30; }
			.panel {
				position: fixed; z-index: 31; background: var(--bg); color: var(--text);
				left: 50%; top: 50%; transform: translate(-50%, -50%);
				width: min(520px, calc(100vw - 32px)); max-height: min(80dvh, 720px);
				display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 6px;
				box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
			}
			header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 14px 16px 8px; }
			h2 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.04em; font-size: 1.2rem; margin: 0; overflow-wrap: anywhere; }
			.x { color: var(--muted); font-size: 1rem; }
			.body { overflow-y: auto; padding: 4px 16px calc(16px + env(safe-area-inset-bottom)); }
			@media (max-width: 899px) {
				.panel { left: 0; right: 0; top: auto; bottom: 0; transform: none; width: 100%; max-height: 85dvh; border-radius: 12px 12px 0 0; border-width: 1px 0 0; }
			}
		`,
	];

	constructor() {
		super();
		this.open = false;
		this.heading = "";
	}

	private onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape" && this.open) this.close();
	};

	connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener("keydown", this.onKey);
	}

	disconnectedCallback(): void {
		document.removeEventListener("keydown", this.onKey);
		super.disconnectedCallback();
	}

	private close(): void {
		this.dispatchEvent(new CustomEvent("pi-close", { bubbles: true, composed: true }));
	}

	render() {
		if (!this.open) return nothing;
		return html`<div class="scrim" @click=${this.close}></div>
			<section class="panel" role="dialog" aria-modal="true" aria-label=${this.heading}>
				<header><h2>${this.heading}</h2><button class="x" aria-label="Close" @click=${this.close}>✕</button></header>
				<div class="body"><slot></slot></div>
			</section>`;
	}
}
customElements.define("pi-sheet", PiSheet);
```

- [ ] **Step 2: Write the sheet bodies**

`app/src/render/sheets.ts`:

```ts
import { css, html, nothing } from "lit";
import type { Dialog, ForkPoint, ModelInfo, Snapshot, ThinkingLevel } from "../../../shared/src/protocol.ts";
import { abbreviateCwd, formatCost, formatTokens } from "../lib/format.ts";

export const UNAVAILABLE_IN_TERMINAL = "Not available while this session is open in the terminal.";

export type DialogAnswer = { value?: string; confirmed?: boolean; cancelled?: boolean };

export function modelSheet(snap: Snapshot, on: { pickModel(m: ModelInfo): void; pickThinking(l: ThinkingLevel): void }) {
	const cur = snap.state.model;
	return html`
		<div class="models" role="listbox" aria-label="Models">
			${snap.models.map((m) => {
				const selected = cur?.provider === m.provider && cur?.id === m.id;
				return html`<button role="option" aria-selected=${selected ? "true" : "false"} class="model ${selected ? "on" : ""}" @click=${() => on.pickModel(m)}>
					<span class="name">${m.name}</span>
					<span class="meta">${m.provider} · ${formatTokens(m.contextWindow)} context${m.input.includes("image") ? " · images" : ""}${m.reasoning ? " · thinking" : ""}</span>
				</button>`;
			})}
		</div>
		${snap.thinkingLevels.length > 1
			? html`<h3 class="label">thinking</h3>
					<div class="seg" role="radiogroup" aria-label="Thinking level">
						${snap.thinkingLevels.map(
							(l) => html`<button role="radio" aria-checked=${snap.state.thinkingLevel === l ? "true" : "false"} class=${snap.state.thinkingLevel === l ? "on" : ""} @click=${() => on.pickThinking(l)}>${l}</button>`,
						)}
					</div>`
			: html`<p class="hint">${cur?.name ?? "This model"} doesn't support thinking levels.</p>`}
	`;
}

export function statsSheet(snap: Snapshot, home: string) {
	const st = snap.stats;
	const ctx = st?.contextUsage;
	const t = st?.tokens;
	const rows: Array<[string, string]> = [
		["context", ctx ? `${ctx.tokens == null ? "—" : formatTokens(ctx.tokens)} of ${formatTokens(ctx.contextWindow)}${ctx.percent != null ? ` (${Math.round(ctx.percent)}%)` : ""}` : "—"],
		["model", snap.state.model ? `${snap.state.model.name} · ${snap.state.thinkingLevel}` : "—"],
		["messages", st ? `${st.userMessages} prompts · ${st.assistantMessages} replies · ${st.toolCalls} tool calls` : "—"],
		["tokens in", t ? formatTokens(t.input) : "—"],
		["tokens out", t ? formatTokens(t.output) : "—"],
		["cache read", t ? formatTokens(t.cacheRead) : "—"],
		["cache write", t ? formatTokens(t.cacheWrite) : "—"],
		["total", t ? formatTokens(t.total) : "—"],
		["cost", st?.cost ? formatCost(st.cost) : "$0"],
		["folder", abbreviateCwd(snap.cwd, home)],
		["session file", snap.sessionFile ?? "not written yet"],
		["session id", snap.sessionId],
		["running as", snap.handleKind === "rpc" ? "headless pi on spark" : "pi in a terminal"],
	];
	return html`<dl class="stats">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

export function dialogSheet(d: Dialog, seenAt: number, respond: (a: DialogAnswer) => void) {
	const left = d.timeout ? Math.max(0, Math.round((seenAt + d.timeout - Date.now()) / 1000)) : null;
	const submitValue = (e: Event) => {
		e.preventDefault();
		respond({ value: String(new FormData(e.target as HTMLFormElement).get("value") ?? "") });
	};
	return html`
		${d.message ? html`<p class="msg">${d.message}</p>` : nothing}
		${d.method === "select" ? html`<div class="opts">${(d.options ?? []).map((o) => html`<button class="btn ghost opt" @click=${() => respond({ value: o })}>${o}</button>`)}</div>` : nothing}
		${d.method === "confirm"
			? html`<div class="row"><button class="btn" @click=${() => respond({ confirmed: true })}>yes</button><button class="btn ghost" @click=${() => respond({ confirmed: false })}>no</button></div>`
			: nothing}
		${d.method === "input"
			? html`<form class="answer" @submit=${submitValue}><input name="value" aria-label=${d.title} placeholder=${d.placeholder ?? ""} /><button class="btn">submit</button></form>`
			: nothing}
		${d.method === "editor"
			? html`<form class="answer" @submit=${submitValue}><textarea name="value" rows="10" aria-label=${d.title} .value=${d.prefill ?? ""}></textarea><button class="btn">submit</button></form>`
			: nothing}
		<div class="foot">
			${left != null ? html`<span class="hint">times out in ${left}s</span>` : html`<span></span>`}
			<button class="dismiss u" @click=${() => respond({ cancelled: true })}>dismiss</button>
		</div>
	`;
}

export function forkSheet(points: ForkPoint[], onFork: (p: ForkPoint) => void) {
	if (!points.length) return html`<p class="hint">There are no earlier messages to fork from yet.</p>`;
	return html`<p class="hint">Start a new session from one of your earlier messages.</p>
		<div class="forks">${points.map((p) => html`<button class="fork" @click=${() => onFork(p)}>${p.text.slice(0, 240)}</button>`)}</div>`;
}

export const sheetStyles = css`
	.models { display: grid; gap: 2px; margin-bottom: 14px; }
	.model { display: grid; text-align: left; padding: 8px 10px; border-left: 2px solid transparent; border-radius: var(--radius); }
	.model:hover { background: var(--panel); }
	.model.on { border-left-color: var(--accent); background: var(--panel); }
	.model .name { font-weight: 500; }
	.model .meta { font-size: 0.75rem; color: var(--text-2); }
	h3.label { margin: 6px 0; font-weight: 400; }
	.seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.seg button { padding: 5px 12px; font-size: 0.85rem; }
	.seg button.on { background: var(--text); color: var(--bg); }
	.hint { color: var(--text-2); font-size: 0.85rem; }
	dl.stats { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 0; font-size: 0.85rem; }
	dl.stats dt { font-family: var(--font-display); color: var(--muted); letter-spacing: 0.04em; }
	dl.stats dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
	.msg { white-space: pre-wrap; margin-top: 0; }
	.opts { display: grid; gap: 6px; }
	.opt { justify-content: flex-start; text-align: left; }
	.row { display: flex; gap: 8px; }
	form.answer { display: grid; gap: 8px; }
	form.answer textarea { width: 100%; font-family: var(--font-mono); }
	.foot { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; }
	.dismiss { color: var(--muted); font-size: 0.85rem; }
	.forks { display: grid; gap: 6px; }
	.fork { text-align: left; border-left: 3px solid var(--accent); padding: 6px 10px; font-family: var(--font-quote); background: var(--panel); border-radius: var(--radius); overflow-wrap: anywhere; }
`;
```

- [ ] **Step 3: Write `pi-composer`**

`app/src/components/pi-composer.ts`:

```ts
import { LitElement, css, html, nothing } from "lit";
import type { ImageInput, PromptMode } from "../../../shared/src/protocol.ts";
import { type SlashItem, filterSlash, slashQuery } from "../lib/slash.ts";
import { toast } from "../lib/toast.ts";
import { UNAVAILABLE_IN_TERMINAL } from "../render/sheets.ts";
import { sharedStyles } from "../styles/shared.ts";

export interface SubmitDetail {
	text: string;
	images: ImageInput[];
	mode: PromptMode;
}

const LONG_PRESS_MS = 500;

export class PiComposer extends LitElement {
	static properties = {
		streaming: { attribute: false },
		items: { attribute: false },
		canImages: { attribute: false },
		rpcOnlyDisabled: { attribute: false },
		queue: { attribute: false },
		statuses: { attribute: false },
		text: { state: true },
		images: { state: true },
		menuIndex: { state: true },
		menuDismissed: { state: true },
	};
	declare streaming: boolean;
	declare items: SlashItem[];
	declare canImages: boolean;
	declare rpcOnlyDisabled: boolean;
	declare queue: { steering: string[]; followUp: string[] };
	declare statuses: string[];
	declare text: string;
	declare images: ImageInput[];
	declare menuIndex: number;
	declare menuDismissed: boolean;
	private pressTimer: ReturnType<typeof setTimeout> | undefined;
	private longPressed = false;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; border-top: 1px solid var(--line); background: var(--bg); padding: 8px 14px calc(10px + env(safe-area-inset-bottom)); position: relative; }
			.inner { max-width: 760px; margin: 0 auto; display: grid; gap: 6px; }
			.queue { display: flex; flex-wrap: wrap; gap: 6px; }
			.chip { font-size: 0.75rem; border: 1px dashed var(--border); border-radius: var(--radius); padding: 2px 8px; color: var(--text-2); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.menu { border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); font-size: 0.82rem; overflow: hidden; max-height: 40vh; overflow-y: auto; }
			.opt { display: flex; gap: 10px; padding: 6px 10px; cursor: pointer; align-items: baseline; }
			.opt.on { background: color-mix(in srgb, var(--accent), transparent 82%); }
			.opt.off { opacity: 0.5; }
			.opt code { font-family: var(--font-mono); flex: none; }
			.opt span { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
			.thumbs { display: flex; gap: 6px; }
			.thumb img { width: 48px; height: 48px; object-fit: cover; border-radius: var(--radius); border: 1px solid var(--line); }
			.box { display: flex; gap: 8px; align-items: flex-end; border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 6px 6px 10px; background: var(--bg); }
			textarea { flex: 1; min-width: 0; border: 0; padding: 4px 0; resize: none; background: transparent; line-height: 1.45; max-height: 40vh; outline: none; }
			.actions { display: flex; gap: 6px; align-items: center; }
			.icon { width: 30px; height: 30px; border-radius: var(--radius); color: var(--text-2); font-size: 1.1rem; }
			.status { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 0.7rem; color: var(--muted); }
		`,
	];

	constructor() {
		super();
		this.streaming = false;
		this.items = [];
		this.canImages = false;
		this.rpcOnlyDisabled = false;
		this.queue = { steering: [], followUp: [] };
		this.statuses = [];
		this.text = "";
		this.images = [];
		this.menuIndex = 0;
		this.menuDismissed = false;
	}

	setText(text: string): void {
		this.text = text;
		this.updateComplete.then(() => this.textarea?.focus());
	}

	// Put a failed message back unless the user already started typing again.
	restore(text: string, images: ImageInput[]): void {
		if (this.text || this.images.length) return;
		this.text = text;
		this.images = images;
	}

	private get textarea(): HTMLTextAreaElement | null {
		return this.renderRoot.querySelector("textarea");
	}

	private get menu(): SlashItem[] {
		const q = slashQuery(this.text);
		return q === null || this.menuDismissed ? [] : filterSlash(this.items, q);
	}

	private submit(mode: PromptMode): void {
		const text = this.text.trim();
		if (!text && this.images.length === 0) return;
		this.dispatchEvent(new CustomEvent<SubmitDetail>("pi-submit", { detail: { text, images: this.images, mode }, bubbles: true, composed: true }));
		this.text = "";
		this.images = [];
		this.menuIndex = 0;
	}

	private complete(item: SlashItem): void {
		if (item.rpcOnly && this.rpcOnlyDisabled) {
			toast(UNAVAILABLE_IN_TERMINAL, "warning");
			return;
		}
		this.setText(`/${item.name} `);
		this.menuIndex = 0;
	}

	private onInput = (e: Event) => {
		this.text = (e.target as HTMLTextAreaElement).value;
		this.menuDismissed = false;
		this.menuIndex = 0;
	};

	private onKey = (e: KeyboardEvent) => {
		const menu = this.menu;
		if (menu.length) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const step = e.key === "ArrowDown" ? 1 : -1;
				this.menuIndex = (this.menuIndex + step + menu.length) % menu.length;
				return;
			}
			if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
				e.preventDefault();
				this.complete(menu[Math.min(this.menuIndex, menu.length - 1)]);
				return;
			}
			if (e.key === "Escape") {
				this.menuDismissed = true;
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) {
			e.preventDefault();
			this.submit(this.streaming ? "steer" : "send");
		}
	};

	private onPressStart = () => {
		this.longPressed = false;
		if (!this.streaming) return;
		this.pressTimer = setTimeout(() => {
			this.longPressed = true;
			this.submit("followUp");
		}, LONG_PRESS_MS);
	};

	private onPressEnd = () => clearTimeout(this.pressTimer);

	private onSendClick = () => {
		if (this.longPressed) {
			this.longPressed = false;
			return;
		}
		this.submit(this.streaming ? "steer" : "send");
	};

	private onFiles = async (e: Event) => {
		const input = e.target as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = "";
		const read = (f: File) =>
			new Promise<ImageInput>((resolve, reject) => {
				const r = new FileReader();
				r.onload = () => resolve({ mimeType: f.type || "image/png", data: String(r.result).replace(/^data:[^,]*,/, "") });
				r.onerror = () => reject(r.error);
				r.readAsDataURL(f);
			});
		try {
			this.images = [...this.images, ...(await Promise.all(files.map(read)))];
		} catch {
			toast("That image couldn't be read.", "error");
		}
	};

	updated(): void {
		const ta = this.textarea;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight}px`;
	}

	render() {
		const menu = this.menu;
		const queued = [...this.queue.steering.map((t) => ["steer", t]), ...this.queue.followUp.map((t) => ["follow-up", t])];
		return html`<div class="inner">
			${queued.length ? html`<div class="queue" aria-label="Queued messages">${queued.map(([k, t]) => html`<span class="chip"><span class="label">${k}</span> ${t}</span>`)}</div>` : nothing}
			${menu.length
				? html`<div class="menu" role="listbox" aria-label="Commands">
						${menu.map(
							(item, i) => html`<div role="option" aria-selected=${i === this.menuIndex ? "true" : "false"} class="opt ${i === this.menuIndex ? "on" : ""} ${item.rpcOnly && this.rpcOnlyDisabled ? "off" : ""}" @pointerdown=${(e: Event) => {
								e.preventDefault();
								this.complete(item);
							}}><code>/${item.name}</code><span>${item.description}</span></div>`,
						)}
					</div>`
				: nothing}
			${this.images.length
				? html`<div class="thumbs">${this.images.map(
						(img, i) => html`<button class="thumb" aria-label="Remove image" @click=${() => (this.images = this.images.filter((_, j) => j !== i))}><img alt="" src="data:${img.mimeType};base64,${img.data}" /></button>`,
					)}</div>`
				: nothing}
			<div class="box">
				<textarea aria-label="Message" rows="1" placeholder=${this.streaming ? "steer pi, or hold send to queue a follow-up" : "message pi, or / for commands"} .value=${this.text} @input=${this.onInput} @keydown=${this.onKey}></textarea>
				<div class="actions">
					${this.canImages
						? html`<label class="icon" aria-label="Attach image" style="display:grid;place-items:center;cursor:pointer">＋<input class="sr-only" type="file" accept="image/*" multiple @change=${this.onFiles} /></label>`
						: nothing}
					${this.streaming ? html`<button class="btn ghost" @click=${() => this.dispatchEvent(new CustomEvent("pi-abort", { bubbles: true, composed: true }))}>stop</button>` : nothing}
					<button class="btn" @pointerdown=${this.onPressStart} @pointerup=${this.onPressEnd} @pointerleave=${this.onPressEnd} @click=${this.onSendClick}>${this.streaming ? "steer" : "send"}</button>
				</div>
			</div>
			${this.statuses.length ? html`<div class="status">${this.statuses.map((s) => html`<span>${s}</span>`)}</div>` : nothing}
		</div>`;
	}
}
customElements.define("pi-composer", PiComposer);
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w app && npm test -w app`
Expected: tsc exits 0 and the unit tests pass. These components are wired up and exercised in Task 15.

- [ ] **Step 5: Commit**

```bash
git add app/src
git commit -m "feat(app): composer with slash menu, steer/follow-up, images; sheets for model, stats, dialogs, fork

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Session view: wire stores, commands, built-ins and sheets

**Files:**
- Create: `app/src/components/pi-session.ts`
- Modify: `app/src/components/pi-app.ts` (add `import "./pi-session.ts";` next to the other component imports)

**Interfaces:**
- Consumes: everything from Tasks 10–14.
- Produces: `<pi-session .api .sessionId .home>`, which:
  - **opens a session:** history first, then the SSE stream, keeping a single `SessionStore`
  - **runs input:** `AppCommand`s, plus the built-ins from spec §5.3
  - **shows sheets:** model, stats, fork, and extension dialogs (a dialog always takes precedence)
  - **follows session changes:** it replaces the URL hash, reopens the stream under the new id, and fires `pi-route-replaced`
  - **scrolls:** keeps the conversation pinned to the bottom while streaming, unless you scroll up

- [ ] **Step 1: Write `pi-session`**

`app/src/components/pi-session.ts`:

```ts
import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import type { AppCommand, CommandResult, ForkPoint, Snapshot, StreamMessage } from "../../../shared/src/protocol.ts";
import { contentText } from "../../../shared/src/reducer.ts";
import type { HubApi } from "../lib/api.ts";
import { abbreviateCwd } from "../lib/format.ts";
import { hrefFor } from "../lib/route.ts";
import { SessionStore } from "../lib/session-store.ts";
import { matchModel, parseInput, slashItems } from "../lib/slash.ts";
import { openStream } from "../lib/stream.ts";
import { toast } from "../lib/toast.ts";
import { type DialogAnswer, UNAVAILABLE_IN_TERMINAL, dialogSheet, forkSheet, modelSheet, sheetStyles, statsSheet } from "../render/sheets.ts";
import { sharedStyles } from "../styles/shared.ts";
import type { PiComposer, SubmitDetail } from "./pi-composer.ts";
import "./pi-composer.ts";
import "./pi-header.ts";
import "./pi-messages.ts";
import "./pi-sheet.ts";

type Sheet = "model" | "stats" | "fork";
const SHEET_TITLES: Record<Sheet, string> = { model: "model", stats: "session", fork: "fork from…" };

export class PiSession extends LitElement {
	static properties = {
		api: { attribute: false },
		sessionId: { attribute: false },
		home: { attribute: false },
		version: { state: true },
		sheet: { state: true },
		forkPoints: { state: true },
		tucked: { state: true },
	};
	declare api: HubApi;
	declare sessionId: string;
	declare home: string;
	declare version: number;
	declare sheet: Sheet | null;
	declare forkPoints: ForkPoint[];
	declare tucked: boolean;

	store: SessionStore | null = null;
	private stream: { close(): void } | null = null;
	private atBottom = true;
	private lastScrollTop = 0;
	private ticker: ReturnType<typeof setInterval> | undefined;

	static styles = [
		sharedStyles,
		sheetStyles,
		css`
			:host { display: flex; flex-direction: column; min-height: 0; height: 100%; }
			.scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
			.tray { border-top: 1px solid var(--line); padding: 4px 14px; font-size: 0.75rem; }
			.tray summary { cursor: pointer; font-weight: 400; }
			.tray pre { font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-2); white-space: pre-wrap; margin: 4px 0; max-height: 30vh; overflow: auto; }
		`,
	];

	constructor() {
		super();
		this.sessionId = "";
		this.home = "";
		this.version = 0;
		this.sheet = null;
		this.forkPoints = [];
		this.tucked = false;
	}

	willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("sessionId") && this.sessionId && this.sessionId !== this.store?.id) this.open(this.sessionId);
	}

	disconnectedCallback(): void {
		this.teardown();
		clearInterval(this.ticker);
		super.disconnectedCallback();
	}

	// ---- lifecycle ------------------------------------------------------------

	private open(id: string): void {
		this.teardown();
		const store = new SessionStore(id);
		this.store = store;
		this.sheet = null;
		this.atBottom = true;
		store.addEventListener("change", this.onStoreChange);
		store.addEventListener("notice", this.onNotice);
		store.addEventListener("snapshot", this.onSnapshot);
		this.api
			.history(id)
			.then((h) => store === this.store && store.setHistory(h))
			.catch((e: Error) => {
				if (store !== this.store) return;
				toast(e.message, "error");
				store.setHistory({ messages: [], live: false, cwd: "" });
			});
		this.connectStream(id);
	}

	private connectStream(id: string): void {
		this.stream?.close();
		const store = this.store;
		if (!store) return;
		this.stream = openStream<StreamMessage>(
			this.api.streamUrl(id),
			(m) => store.apply(m),
			(s) => store.setStreamStatus(s),
		);
	}

	private teardown(): void {
		this.stream?.close();
		this.stream = null;
		const s = this.store;
		if (!s) return;
		s.removeEventListener("change", this.onStoreChange);
		s.removeEventListener("notice", this.onNotice);
		s.removeEventListener("snapshot", this.onSnapshot);
	}

	private onStoreChange = () => {
		this.version++;
		const dialogOpen = (this.store?.dialogs.length ?? 0) > 0;
		if (dialogOpen && !this.ticker) this.ticker = setInterval(() => this.requestUpdate(), 1000); // timeout countdowns
		if (!dialogOpen && this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	};

	private onNotice = (e: Event) => {
		const m = (e as CustomEvent<StreamMessage>).detail;
		if (m.type === "notify") toast(m.message, m.level);
		else if (m.type === "command_error") toast(m.error, "error");
		else if (m.type === "error") toast(m.message, "error");
		else if (m.type === "editor_text") this.composer?.setText(m.text);
	};

	// Fork, clone and new move this process to another session id.
	private onSnapshot = () => {
		const id = this.store?.id;
		if (!id || id === this.sessionId) return;
		history.replaceState(null, "", hrefFor({ name: "session", id }));
		this.connectStream(id);
		this.dispatchEvent(new CustomEvent("pi-route-replaced", { detail: { name: "session", id }, bubbles: true, composed: true }));
	};

	// ---- commands -------------------------------------------------------------

	private get composer(): PiComposer | null {
		return this.renderRoot.querySelector("pi-composer");
	}

	private async run(cmd: AppCommand): Promise<CommandResult | null> {
		const s = this.store;
		if (!s) return null;
		s.markStarting();
		try {
			const r = await this.api.command(s.id, cmd);
			if (!r.result.ok && r.result.error) toast(r.result.error, "error");
			return r.result;
		} catch (e) {
			toast((e as Error).message, "error");
			s.cancelStarting();
			return null;
		}
	}

	private onSubmit = async (e: Event) => {
		const { text, images, mode } = (e as CustomEvent<SubmitDetail>).detail;
		this.atBottom = true;
		const parsed = parseInput(text);
		let ok: boolean;
		if (parsed.kind === "bash") ok = await this.runBash(parsed.command, parsed.excludeFromContext);
		else if (parsed.kind === "builtin") ok = await this.runBuiltin(parsed.name, parsed.args);
		else {
			const streaming = this.store?.conv.streaming ?? false;
			const r = await this.run({ type: "prompt", text: parsed.text, images: images.length ? images : undefined, mode: streaming ? mode : "send" });
			ok = Boolean(r?.ok);
		}
		if (!ok) this.composer?.restore(text, images);
	};

	private onAbort = () => void this.run({ type: "abort" });

	private async runBash(command: string, excludeFromContext: boolean): Promise<boolean> {
		if (this.store?.snapshot && !this.store.snapshot.capabilities.bash) {
			toast(UNAVAILABLE_IN_TERMINAL, "warning");
			return false;
		}
		return Boolean((await this.run({ type: "bash", command, excludeFromContext }))?.ok);
	}

	private async runBuiltin(name: string, args: string): Promise<boolean> {
		const snap = this.store?.snapshot ?? null;
		const caps = snap?.capabilities;
		switch (name) {
			case "model": {
				const m = args && snap ? matchModel(snap.models, args) : null;
				if (m) return Boolean((await this.run({ type: "set_model", provider: m.provider, modelId: m.id }))?.ok);
				if (args && snap) toast(`No single model matches “${args}”. Pick one from the list.`, "warning");
				this.openSheet("model");
				return true;
			}
			case "thinking": {
				const level = snap?.thinkingLevels.find((l) => l === args);
				if (level) return Boolean((await this.run({ type: "set_thinking", level }))?.ok);
				this.openSheet("model");
				return true;
			}
			case "compact":
				return Boolean((await this.run({ type: "compact", instructions: args || undefined }))?.ok);
			case "name":
				if (args) return Boolean((await this.run({ type: "rename", name: args }))?.ok);
				toast(snap?.state.sessionName ? `This session is named “${snap.state.sessionName}”.` : "This session has no name yet. Type /name and a name to set one.");
				return true;
			case "session":
				this.openSheet("stats");
				return true;
			case "new":
				location.hash = hrefFor({ name: "new", cwd: snap?.cwd ?? this.store?.cwdHint ?? undefined });
				return true;
			case "resume":
				this.dispatchEvent(new CustomEvent("pi-open-nav", { bubbles: true, composed: true }));
				return true;
			case "copy": {
				const r = await this.run({ type: "get_last_assistant_text" });
				const text = (r?.data as { text?: string | null } | undefined)?.text;
				if (!text) {
					toast("There's no reply to copy yet.");
					return true;
				}
				try {
					await navigator.clipboard.writeText(text);
					toast("Copied the last reply.");
				} catch {
					toast("The browser blocked clipboard access.", "error");
				}
				return true;
			}
			case "fork": {
				if (caps && !caps.fork) {
					toast(UNAVAILABLE_IN_TERMINAL, "warning");
					return false;
				}
				const r = await this.run({ type: "get_fork_points" });
				if (!r?.ok) return false;
				this.forkPoints = (r.data as { messages: ForkPoint[] }).messages;
				this.openSheet("fork");
				return true;
			}
			case "clone":
				if (caps && !caps.clone) {
					toast(UNAVAILABLE_IN_TERMINAL, "warning");
					return false;
				}
				return Boolean((await this.run({ type: "clone" }))?.ok);
			case "export": {
				if (caps && !caps.export) {
					toast(UNAVAILABLE_IN_TERMINAL, "warning");
					return false;
				}
				const r = await this.run({ type: "export" });
				const file = (r?.data as { name?: string } | undefined)?.name;
				if (!file) return false;
				await this.api.downloadExport(file).catch((e: Error) => toast(e.message, "error"));
				return true;
			}
		}
		return false;
	}

	private openSheet(sheet: Sheet): void {
		this.sheet = sheet;
		if (!this.store?.snapshot) void this.run({ type: "attach" }); // models and stats need a running pi
	}

	private answer(id: string, a: DialogAnswer): void {
		const s = this.store;
		if (!s) return;
		s.dialogs = s.dialogs.filter((d) => d.id !== id);
		this.version++;
		void this.run({ type: "dialog_response", id, ...a });
	}

	// ---- scrolling ------------------------------------------------------------

	private onScroll = (e: Event) => {
		const el = e.target as HTMLElement;
		this.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		const delta = el.scrollTop - this.lastScrollTop;
		if (Math.abs(delta) > 8) this.tucked = delta > 0 && el.scrollTop > 60 && !this.atBottom;
		this.lastScrollTop = el.scrollTop;
	};

	updated(): void {
		if (!this.atBottom) return;
		const el = this.renderRoot.querySelector<HTMLElement>(".scroll");
		if (el) el.scrollTop = el.scrollHeight;
	}

	// ---- render ---------------------------------------------------------------

	render() {
		const s = this.store;
		if (!s) return nothing;
		const snap = s.snapshot;
		const firstPrompt = s.conv.messages.find((m) => m.role === "user");
		const heading = snap?.state.sessionName || s.nameHint || (firstPrompt ? contentText(firstPrompt.content).split("\n")[0].slice(0, 80) : "") || "new session";
		const cwd = snap?.cwd ?? s.cwdHint;
		const statuses = [cwd ? abbreviateCwd(cwd, this.home) : null, ...Object.values(snap?.statuses ?? {})].filter((x): x is string => Boolean(x));
		const dialog = s.dialogs[0];
		return html`
			<pi-header .store=${s} .version=${this.version} .heading=${heading} ?tucked=${this.tucked} @pi-open-sheet=${(e: CustomEvent<Sheet>) => this.openSheet(e.detail)}></pi-header>
			<div class="scroll" @scroll=${this.onScroll}>
				<pi-messages .conv=${s.conv} .version=${this.version}></pi-messages>
			</div>
			${this.renderTray(snap)}
			<pi-composer
				.streaming=${s.conv.streaming}
				.items=${slashItems(snap?.commands ?? [])}
				.canImages=${Boolean(snap?.state.model?.input.includes("image"))}
				.rpcOnlyDisabled=${snap?.handleKind === "bridge"}
				.queue=${s.conv.queue}
				.statuses=${statuses}
				@pi-submit=${this.onSubmit}
				@pi-abort=${this.onAbort}
			></pi-composer>
			${dialog
				? html`<pi-sheet open heading=${dialog.title || "pi needs an answer"} @pi-close=${() => this.answer(dialog.id, { cancelled: true })}>
						${dialogSheet(dialog, s.dialogSeenAt.get(dialog.id) ?? Date.now(), (a) => this.answer(dialog.id, a))}
					</pi-sheet>`
				: this.sheet
					? html`<pi-sheet open heading=${SHEET_TITLES[this.sheet]} @pi-close=${() => (this.sheet = null)}>${this.renderSheet(this.sheet, snap)}</pi-sheet>`
					: nothing}
		`;
	}

	private renderSheet(sheet: Sheet, snap: Snapshot | null) {
		if (sheet === "fork")
			return forkSheet(this.forkPoints, (p) => {
				this.sheet = null;
				void this.run({ type: "fork", entryId: p.entryId });
			});
		if (!snap) return html`<p class="hint">starting pi…</p>`;
		if (sheet === "stats") return statsSheet(snap, this.home);
		return modelSheet(snap, {
			pickModel: (m) => {
				this.sheet = null;
				void this.run({ type: "set_model", provider: m.provider, modelId: m.id });
			},
			pickThinking: (level) => void this.run({ type: "set_thinking", level }),
		});
	}

	private renderTray(snap: Snapshot | null) {
		const widgets = Object.entries(snap?.widgets ?? {});
		if (!widgets.length) return nothing;
		return html`<details class="tray"><summary class="label">extensions (${widgets.length})</summary>${widgets.map(([key, w]) => html`<pre title=${key}>${w.lines.join("\n")}</pre>`)}</details>`;
	}
}
customElements.define("pi-session", PiSession);
```

Then add the import to `app/src/components/pi-app.ts`, next to the other component imports:

```ts
import "./pi-session.ts";
```

- [ ] **Step 2: Typecheck and unit tests**

Run: `npm run typecheck -w app && npm test -w app`
Expected: tsc exits 0 and all unit tests pass.

- [ ] **Step 3: Exercise it against the dev hub with Michael's real sessions**

Run:
```bash
npm run dev -w hub > /tmp/hub.log 2>&1 &
npm run dev -w app > /tmp/vite.log 2>&1 &
```
Ask Michael to open http://localhost:5173 through `ssh -L 5173:localhost:5173 spark-713a` and check this list. Note: these use his real local models on spark.
1. **Open an existing session from the CLI** (for example the JPL portfolio one). History renders straight from the file, including tool cards and thinking lines, and the header reads "pi isn't running for this session…".
2. **Send a short prompt.** The header shows "starting pi…" for about 1–2s, then the reply streams. The context meter and `used / 262k` fill in after the turn.
3. **Tap the model in the header**, pick "Qwen3.6 35B-A3B (fast)", and set thinking to `low`. The header updates.
4. **Type `/co`.** The command menu lists `/copy`, `/compact`, `/context`, `/council` and `/clone`. Then try `/name portfolio test`: the header title changes, and the sidebar title follows within a few seconds.
5. **While a reply streams,** press **stop**. The reply ends with "stopped".
6. **Run `!ls`.** A `$ ls` card appears.
7. **Open the same session in a second tab.** Both stream the same reply.
8. **Trigger a permission prompt** (one of his extensions, for example `rm -rf /tmp/pi-web-test` with `pi-permission-system`). The dialog sheet appears and answering it unblocks the run.

Fix any issue found before committing. Then stop the servers: `pkill -f vite; pkill -f "src/main.ts"`.

- [ ] **Step 4: Commit**

```bash
git add app/src
git commit -m "feat(app): session view with live streaming, built-in slash commands, sheets and dialogs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 16: End-to-end smoke tests and README

**Files:**
- Create: `app/e2e/hub-for-e2e.ts`, `app/e2e/smoke.spec.ts`, `app/playwright.config.ts`, `README.md`

**Interfaces:**
- Consumes: the whole hub and app, plus the hub test harness (`startFakeModel`, `makePiEnv`).
- Produces: `npm run e2e -w app`, two smoke tests (a desktop flow and a phone flow) against real pi and a fake model, and the README.

- [ ] **Step 1: Write the e2e hub launcher**

`app/e2e/hub-for-e2e.ts`. Playwright starts this as a web server. It runs a fake model, an isolated pi config, and the real hub on :7899.

```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeModel } from "../../hub/test/support/fake-model.ts";
import { makePiEnv } from "../../hub/test/support/pi-env.ts";

const PORT = 7899; // keep in sync with playwright.config.ts
const WORKDIR = join(tmpdir(), "pi-web-e2e-work"); // keep in sync with smoke.spec.ts

const model = await startFakeModel();
const pi = makePiEnv({ modelUrl: model.url });
rmSync(WORKDIR, { recursive: true, force: true });
mkdirSync(WORKDIR, { recursive: true });

const dataDir = join(pi.root, "hub");
mkdirSync(dataDir);
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ port: PORT, hostname: "localhost:5173", allowedLogin: "dev@local", dev: true, piBin: pi.piBin }));

Object.assign(process.env, pi.env, { PI_WEB_DATA_DIR: dataDir });
process.on("exit", () => pi.cleanup());
await import("../../hub/src/main.ts");
```

- [ ] **Step 2: Write the Playwright config and the smoke tests**

`app/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

const HUB_PORT = 7899; // keep in sync with e2e/hub-for-e2e.ts

export default defineConfig({
	testDir: "e2e",
	timeout: 60_000,
	expect: { timeout: 15_000 },
	workers: 1,
	use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
	projects: [
		{ name: "desktop", use: { ...devices["Desktop Chrome"] } },
		{ name: "phone", use: { ...devices["Pixel 7"] } },
	],
	webServer: [
		{ command: "node e2e/hub-for-e2e.ts", port: HUB_PORT, reuseExistingServer: false, timeout: 30_000 },
		{ command: "npx vite --port 5173 --strictPort", port: 5173, reuseExistingServer: false, env: { PI_WEB_HUB: `http://127.0.0.1:${HUB_PORT}` } },
	],
});
```

`app/e2e/smoke.spec.ts`:

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const WORKDIR = join(tmpdir(), "pi-web-e2e-work"); // keep in sync with hub-for-e2e.ts

async function startSession(page: import("@playwright/test").Page) {
	await page.goto("/#/new");
	await page.getByLabel("Folder path").fill(WORKDIR);
	await page.getByRole("button", { name: "start session" }).click();
	await expect(page).toHaveURL(/#\/s\//);
}

test("desktop: start a session, stream a reply, switch model, rename with a slash command", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	await startSession(page);
	const input = page.getByLabel("Message");
	await input.fill("hi");
	await input.press("Enter");
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await expect(page.getByRole("button", { name: "Session stats" })).toContainText("/ 1k"); // fake-a has a 1000-token window

	await page.getByRole("button", { name: /^Model Fake A/ }).click();
	await page.getByRole("option", { name: /Fake B/ }).click();
	await expect(page.getByRole("button", { name: /^Model Fake B/ })).toBeVisible();

	await input.fill("/na");
	await expect(page.getByRole("listbox", { name: "Commands" })).toContainText("/name");
	await input.press("Enter");
	await expect(input).toHaveValue("/name ");
	await input.pressSequentially("e2e run");
	await input.press("Enter");
	await expect(page.locator("pi-header h1")).toHaveText("e2e run");
	await expect(page.locator("pi-sidebar")).toContainText("e2e run");
});

test("phone: send with the button, then find the session from the menu", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone flow");
	await startSession(page);
	await page.getByLabel("Message").fill("hello from the phone");
	await page.getByRole("button", { name: "send" }).click();
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await page.locator("pi-header").getByRole("button", { name: "Open sessions" }).click();
	await expect(page.locator("pi-sidebar")).toContainText("hello from the phone");
});
```

- [ ] **Step 3: Install the browser and run the tests**

Run:
```bash
cd app && npx playwright install chromium && cd ..
npm run e2e -w app
```
Expected: two tests pass. Each project skips the other's test, so the report shows 2 passed and 2 skipped.
- If `playwright install` reports missing system libraries, `npx playwright install-deps chromium` needs sudo, so **ask Michael** to run it with `! sudo npx --prefix app playwright install-deps chromium`.
- If the stats assertion fails because the context number is missing, check `get_session_stats` in a hub test against the fake model. The fake must send its usage chunk for pi to report `contextUsage.tokens`.

- [ ] **Step 4: Write the README**

`README.md`:

````markdown
# pi, that's it.

A PWA for the [pi](https://pi.dev) coding agent running on spark: browse every
session (CLI or app), continue them with live streaming, start new ones, switch
models and thinking levels, watch context usage, and use slash commands. Styled
after thatsit.dev.

- `hub/`: Node server on spark. Runs one headless `pi --mode rpc` per open
  session, serves REST + SSE, accepts only your Tailscale identity from the
  app's origin. Zero runtime dependencies; runs `.ts` directly on Node ≥ 22.18.
- `app/`: Vite + Lit PWA (static; deploys to pi.thatsit.dev).
- `shared/`: wire types and the conversation reducer both sides use.
- Design: `docs/superpowers/specs/2026-10-10-pi-web-design.md`.

## Develop

```bash
npm install
mkdir -p .dev-data && cat > .dev-data/config.json <<'EOF'
{ "port": 7878, "hostname": "localhost:5173", "allowedLogin": "dev@local", "dev": true }
EOF
npm run dev -w hub    # hub on 127.0.0.1:7878, using your real ~/.pi/agent sessions
npm run dev -w app    # app on http://localhost:5173 (proxies /api and plays tailscale serve)
```

From another machine: `ssh -L 5173:localhost:5173 spark-713a`, then open
http://localhost:5173.

## Test

```bash
npm test              # shared + hub (node:test, real pi against a fake model) + app (vitest)
npm run typecheck
npm run e2e -w app    # Playwright: desktop + phone flows against the real hub
```

Tests never touch `~/.pi/agent`: every pi they start gets a temporary
`PI_CODING_AGENT_DIR` with a fake OpenAI-compatible model.

## Configure for real use

`~/.config/pi-web/config.json` (created on first start):

```json
{
  "port": 7878,
  "hostname": "spark-713a.tail9274fa.ts.net:7878",
  "allowedLogin": "michaelthatsit@github",
  "allowedOrigins": ["https://pi.thatsit.dev"],
  "idleMinutes": 20,
  "maxHeadless": 6,
  "piBin": "pi"
}
```

Deployment (tailscale serve, Netlify, systemd), terminal sync (the bridge
extension) and push notifications are Plans 2–4.
````

- [ ] **Step 5: Run everything once more and commit**

Run: `npm run typecheck && npm test && npm run e2e -w app`
Expected: all of it passes.

```bash
git add app/e2e app/playwright.config.ts README.md
git commit -m "test(app): Playwright smoke tests against real pi and a fake model; README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After this plan

- **Plan 2: bridge.** `bridge/` pi extension, the hub's Unix socket listener, `BridgeHandle implements SessionHandle`, the collision rules (§3.2), and the `bridge` capabilities in the UI (`rpcOnlyDisabled`, "open in terminal").
- **Plan 3: push.** VAPID keys, `/api/push/*`, `web-push`, service-worker `push` and `notificationclick` handlers, and the settings toggle.
- **Plan 4: deploy.** Netlify site `pi.thatsit.dev`, `tailscale serve --bg --https=7878 http://127.0.0.1:7878`, a systemd user unit for the hub, and the bridge added to `~/.pi/agent/settings.json` `packages`.
