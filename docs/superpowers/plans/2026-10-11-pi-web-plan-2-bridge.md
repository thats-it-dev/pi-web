# pi-web Plan 2: Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `pi` started in a terminal shows up live in pi-web, synced both ways. The app watches it stream, sends prompts and steers to it, switches its model and thinking level, compacts and renames it, and follows it through TUI `/new`, `/resume` and `/fork`.

**Architecture:** A pi extension (`bridge/`) runs inside every terminal `pi`. It connects to the hub over a Unix socket, sends pi's events in RPC shapes plus periodic state "syncs", and runs the app's commands through the extension API. The hub wraps each connection in a `BridgeHandle` that implements the existing `SessionHandle` seam, so the server, the shared reducer and the app work unchanged. The `Registry` gains the collision rules from spec §3.2: an idle headless pi gives way to the terminal, a busy one makes it wait, and the hub's own children are ignored.

**Tech Stack:** Node ≥ 22.18 running TypeScript by type stripping, `node:net` Unix sockets, `node:test`, and pi 1.0.2's extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, both provided by pi as virtual modules). The app uses Lit, Vitest and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-10-pi-web-design.md` (§2.2, §2.3 "Bridge ↔ hub", §3.2, §5.3, §5.4, §7, §8). Plan 1, which built the hub and app, is `docs/superpowers/plans/2026-10-10-pi-web-plan-1-hub-and-app.md`.

## Global Constraints

- Node ≥ 22.18. TypeScript runs by type stripping (`erasableSyntaxOnly`), so there are no parameter properties, enums or namespaces. Definite-assignment `!` and `declare` fields are fine.
- Code style follows the repo: tabs, double quotes, `.ts` extensions in relative imports, and short header comments that say what a file is for.
- `bridge/` has **no npm dependencies**. It imports only Node built-ins, pi's virtual modules (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`), and `../shared/src/*`.
- The hub gains no runtime dependency.
- The socket is `<dataDir>/bridge.sock`, which is `~/.config/pi-web/bridge.sock` by default. It has mode `0600`, inside a `0700` directory.
- The bridge finds the socket at `$PI_WEB_BRIDGE_SOCKET`, else `$PI_WEB_DATA_DIR/bridge.sock`, else `~/.config/pi-web/bridge.sock`.
- When the hub is down, the bridge retries silently, starting at 1 s and doubling up to 60 s. It never blocks pi startup and never prints to the TUI about connection trouble.
- The bridge does nothing when `PI_WEB=1`, which marks the hub's own headless children (`RpcHandle` sets it).
- The hub never closes a bridge handle (spec §3.2). Bridge handles don't count toward `maxHeadless`.
- Exact copy:
  - Unavailable actions: `Not available while open in the terminal.`
  - Header while terminal-owned: `open in terminal`
  - Header while a terminal dialog is open: `waiting for you in the terminal: <title>`
  - Composer placeholder when nothing is running: `continue here`
  - Notice in the terminal when a busy headless pi holds the session: `This session is running in pi-web. Wait for it to finish, or /quit.`
  - Notice when another terminal already holds the session: `This session is open in another terminal; pi-web follows that one.`
- Pi facts the code relies on (verified against pi 1.0.2 on 2026-10-11):
  - `pi.sendUserMessage` works from any callback, not only inside handlers. `deliverAs` works while streaming.
  - Prompt templates and skills expand only with `expandPromptTemplates: true`.
  - **Extension commands never run from `sendUserMessage`.** The text would go to the model literally.
  - Extension `message_update` events carry `message` and `assistantMessageEvent.partial`. RPC mode strips both.
  - Extensions get no `queue_update`, `compaction_*` or `auto_retry_*` events. They do get `session_before_compact`, `session_compact`, `session_compact_failed`, `ui_prompt_start` and `ui_prompt_end`.
  - A TUI `/new`, `/resume` or `/fork` replaces the extension runtime: `session_shutdown {reason}`, then a fresh factory call and `session_start`.
  - `settings.json` `extensions: ["/abs/path.ts"]` loads a file.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A TUI `/new`, `/resume` or `/fork`.** The old runtime's `bye` and the new runtime's `hello` arrive on different sockets, in either order. `session_start` may fire more than once. Expect exactly one bridge handle per pid, no duplicated events, and the app's stream following to the new session id. Pinned in Task 7 (hello-before-bye and duplicate-hello tests) and Task 8 (real `/new`).
2. **The app has a session open headless when the terminal resumes it.** The headless pi's `handle_gone` arrives only after the child exits, which is after the bridge was adopted. Expect the open stream to switch to the terminal without a page reload. Pinned in Task 6 (server re-attach test) and Task 8 (real takeover).
3. **The hub restarts while a terminal pi runs.** Expect the bridge to reconnect silently and the session to reappear live with its full conversation. Pinned in Task 3 (reconnect sends a fresh full `hello`).
4. **An extension command (`/ask`) is sent from the app to a terminal session.** Expect a clear error, with nothing sent to the model, and the command shown disabled in the slash menu. Pinned in Task 3 (bridge refuses), Task 4 (real pi: the model never sees `/ask`) and Task 9 (slash item disabled).
5. **A terminal pi runs with no hub, or with a stale socket file left by a crashed hub.** Expect pi to start and work normally with no bridge output, and a later hub to remove the stale file and bind. Pinned in Task 4 (no socket) and Task 7 (stale socket replaced, live hub refused).

## Known limitations (record in the spec, Task 1)

On a bridge session the app does not show the following, because pi's extension API doesn't expose it:

- queue chips (no `queue_update`)
- "retrying (n/max)" (no `auto_retry_*`)
- other extensions' `setStatus`, `setWidget` and `notify` output
- extension dialog contents (the app shows "waiting for you in the terminal" instead)

Extension commands can't be run from the app; prompt templates and skills can. A manual compaction cancelled by another extension leaves "compacting…" showing until the next run settles.

## File map

| File | Responsibility |
|---|---|
| `shared/src/jsonl.ts` (moved from `hub/src/`) | LF-only JSONL line splitter, used by the hub, the bridge and test helpers |
| `shared/src/protocol.ts` (modify) | `TerminalPrompt`; `terminalPrompt` on `Snapshot` and `meta` |
| `shared/src/bridge.ts` (new) | Bridge ↔ hub wire types |
| `bridge/package.json`, `bridge/tsconfig.json`, `bridge/pi-modules.d.ts` (new) | Workspace, pi package manifest, and type stubs for pi's virtual modules |
| `bridge/wire.ts` (new) | Pure translations: pi extension shapes → RPC wire shapes, stats, model and command lists |
| `bridge/client.ts` (new) | Socket client with silent exponential backoff |
| `bridge/session.ts` (new) | One bridged pi session: hello and sync, event forwarding, command execution |
| `bridge/index.ts` (new) | The pi extension entry: lifecycle wiring, socket path |
| `hub/src/bridge-handle.ts` (new) | `BridgeHandle implements SessionHandle` |
| `hub/src/bridge-server.ts` (new) | Unix socket listener; connection ↔ handle bookkeeping across runtime switches |
| `hub/src/registry.ts` (modify) | `attachBridge`, collision rules, waiting bridges |
| `hub/src/handle.ts` (modify) | Optional `notice(text)` |
| `hub/src/server.ts` (modify) | Re-attach a stream when another handle took over |
| `hub/src/rpc-handle.ts` (modify) | `terminalPrompt: null`; emit over a copy of listeners |
| `hub/src/main.ts` (modify) | Start the bridge server |
| `hub/test/support/recorder.ts`, `fake-hub.ts`, `terminal-pi.ts` (new) | Test helpers shared by the bridge, hub and e2e tests |
| `app/src/lib/status.ts` (new, moved from `pi-header.ts`) | `headerStatus()`, testable without the DOM |
| `app/src/lib/slash.ts`, `pi-composer.ts`, `pi-session.ts`, `session-store.ts` (modify) | Extension commands disabled on a bridge session; `continue here`; `terminalPrompt` |

---

### Task 1: Shared protocol for the bridge

**Files:**
- Move: `hub/src/jsonl.ts` → `shared/src/jsonl.ts`, `hub/test/jsonl.test.ts` → `shared/test/jsonl.test.ts`
- Modify: `hub/src/rpc-handle.ts` (imports, `terminalPrompt`, `emit`), `hub/test/harness.test.ts:4`, `hub/test/support/fake-handle.ts`, `app/src/lib/session-store.ts:73-75`, `app/src/lib/session-store.test.ts:11,34`
- Modify: `shared/src/protocol.ts`
- Create: `shared/src/bridge.ts`
- Modify: `docs/superpowers/specs/2026-10-10-pi-web-design.md` §2.3 and new §2.4

**Interfaces:**
- Produces:
  - `lineSplitter(onLine: (line: string) => void): (chunk: string) => void` from `shared/src/jsonl.ts`.
  - `TerminalPrompt { kind: string; title: string }`.
  - `Snapshot.terminalPrompt: TerminalPrompt | null`, and the same field on the `meta` `StreamMessage`.
  - From `shared/src/bridge.ts`: `BRIDGE_PROTOCOL = 1`, `BridgeSync`, `FullSync`, `BridgeCommand`, `ByeReason`, `BridgeHello`, `BridgeToHub`, `HubToBridge`, `BridgeResult`.

- [ ] **Step 1: Move the line splitter to `shared/`**

```bash
git mv hub/src/jsonl.ts shared/src/jsonl.ts
git mv hub/test/jsonl.test.ts shared/test/jsonl.test.ts
```

`shared/test/jsonl.test.ts` already imports `../src/jsonl.ts`, so it needs no change. Update the other two importers:

- `hub/src/rpc-handle.ts`: replace `import { lineSplitter } from "./jsonl.ts";` with `import { lineSplitter } from "../../shared/src/jsonl.ts";`
- `hub/test/harness.test.ts`: replace `import { lineSplitter } from "../src/jsonl.ts";` with `import { lineSplitter } from "../../shared/src/jsonl.ts";`

Run: `npm test -w shared && npm run typecheck -w hub`
Expected: PASS. The jsonl tests now run under `shared`.

- [ ] **Step 2: Add `TerminalPrompt` to the protocol**

In `shared/src/protocol.ts`, after `interface Widget`, add:

```ts
// A blocking extension dialog open in a terminal pi (bridge sessions only).
// The app can't answer it; it says "waiting for you in the terminal".
export interface TerminalPrompt {
	kind: string; // select | confirm | input | editor | custom
	title: string;
}
```

Add `terminalPrompt: TerminalPrompt | null;` as the last field of `Snapshot`, and as the last field of the `meta` member of `StreamMessage`:

```ts
	| {
			type: "meta";
			state: SessionStateInfo;
			stats: SessionStats | null;
			statuses: Record<string, string>;
			widgets: Record<string, Widget>;
			thinkingLevels: ThinkingLevel[];
			terminalPrompt: TerminalPrompt | null;
	  }
```

- [ ] **Step 3: Run typecheck to see every literal that needs the field**

Run: `npm run typecheck`
Expected: FAIL. The failures are in `hub/src/rpc-handle.ts` (`snapshot()`, `meta()`), `hub/test/support/fake-handle.ts` (`snapshot()`) and `app/src/lib/session-store.test.ts` (the `snap()` helper, and the `meta` message on line 34).

- [ ] **Step 4: Fill in `terminalPrompt` everywhere**

- `hub/src/rpc-handle.ts`, in `snapshot()`: add `terminalPrompt: null,` after `widgets: this.widgets,`.
- `hub/src/rpc-handle.ts`, in `meta()`: return `{ type: "meta", state: this.state as SessionStateInfo, stats: this.stats, statuses: this.statuses, widgets: this.widgets, thinkingLevels: this.thinkingLevels, terminalPrompt: null }`.
- `hub/test/support/fake-handle.ts`, in `snapshot()`: add `terminalPrompt: null,` after `widgets: {},`.
- `app/src/lib/session-store.test.ts:11`: end the line with `statuses: {}, widgets: {}, terminalPrompt: null,`.
- `app/src/lib/session-store.test.ts:34`: add `terminalPrompt: null` to the `meta` message object.
- `app/src/lib/session-store.ts:74`: replace the `meta` case body with:

```ts
				if (this.snapshot) Object.assign(this.snapshot, { state: msg.state, stats: msg.stats, statuses: msg.statuses, widgets: msg.widgets, thinkingLevels: msg.thinkingLevels, terminalPrompt: msg.terminalPrompt });
```

Also in `hub/src/rpc-handle.ts`, make `emit` iterate over a copy. A registry listener can add or remove listeners on the same handle while it runs (Task 6), and a live `Set` would then deliver the same event to the new listener:

```ts
	private emit(e: HandleEvent): void {
		for (const fn of [...this.listeners]) fn(e);
	}
```

- [ ] **Step 5: Write the bridge wire types**

Create `shared/src/bridge.ts`:

```ts
// Bridge ↔ hub wire protocol (spec §2.3): newline-delimited JSON over the
// hub's Unix socket. The bridge is a pi extension inside a terminal `pi`.
// Events use pi's RPC shapes, so the shared reducer serves both handle kinds.

import type { AgentMessage, AppCommand, CommandInfo, ModelInfo, PiEvent, SessionStateInfo, SessionStats, TerminalPrompt, ThinkingLevel } from "./protocol.ts";

export const BRIDGE_PROTOCOL = 1;

// State the bridge pushes after turns, model, thinking and name changes.
export interface BridgeSync {
	state: SessionStateInfo;
	stats: SessionStats | null;
	thinkingLevels: ThinkingLevel[];
}

// Everything a snapshot needs; sent with hello and after compaction.
export interface FullSync extends BridgeSync {
	models: ModelInfo[];
	commands: CommandInfo[];
	messages: AgentMessage[];
}

// The app commands a terminal pi can run (spec §2.2 capability table).
export type BridgeCommand = Extract<AppCommand, { type: "prompt" | "abort" | "set_model" | "set_thinking" | "compact" | "rename" }>;

export type ByeReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface BridgeHello {
	type: "hello";
	protocol: number;
	sessionId: string;
	sessionFile: string | null;
	cwd: string;
	pid: number;
	piVersion: string;
	sync: FullSync;
	prompt: TerminalPrompt | null;
}

export interface BridgeResult {
	ok: boolean;
	data?: unknown;
	error?: string;
}

export type BridgeToHub =
	| BridgeHello
	| { type: "event"; event: PiEvent }
	| { type: "sync"; sync: BridgeSync | FullSync }
	| { type: "prompt_state"; prompt: TerminalPrompt | null }
	| ({ type: "result"; id: string } & BridgeResult)
	| { type: "bye"; reason: ByeReason };

export type HubToBridge = { type: "cmd"; id: string; command: BridgeCommand } | { type: "notice"; text: string };
```

- [ ] **Step 6: Update the spec**

In `docs/superpowers/specs/2026-10-10-pi-web-design.md`, replace the two bullets under **Bridge ↔ hub** in §2.3 (the "Bridge → hub" and "Hub → bridge" bullets, not the socket line or the `hello` re-send bullet) with:

```markdown
- Bridge → hub (types in `shared/src/bridge.ts`):
  - `hello {protocol, sessionId, sessionFile, cwd, pid, piVersion, sync: FullSync, prompt}`. `FullSync` is `{state, stats, thinkingLevels, models, commands, messages}`, everything a snapshot needs.
  - `event {event}`: pi events in RPC shapes, with `message` and `partial` stripped from `message_update` the way RPC mode's `toJsonEvent` strips them. `compaction_start` and `compaction_end` are synthesized from `session_before_compact`, `session_compact` and `session_compact_failed`.
  - `sync {sync}`: state, stats and thinking levels after `turn_end`, `agent_settled`, a model, thinking or name change; the full sync after compaction.
  - `prompt_state {prompt}`: a blocking TUI dialog opened or closed (`ui_prompt_start` / `ui_prompt_end`).
  - `result {id, ok, data?, error?}`
  - `bye {reason}`: `reason` is `session_shutdown`'s.
- Hub → bridge: `cmd {id, command}`, where `command` is `prompt`, `abort`, `set_model`, `set_thinking`, `compact` or `rename`; and `notice {text}`, shown with `ctx.ui.notify`.
- A TUI `/new`, `/resume` or `/fork` replaces pi's extension runtime, so the old connection says `bye` and a new connection says `hello` from the same pid, in either order. The hub keeps the same `BridgeHandle` for a pid through a 5 s grace period and re-keys it.
```

Then add a new subsection after §2.3:

```markdown
### 2.4 Bridge limitations

pi's extension API has no `queue_update`, `auto_retry_*`, or view of other extensions' UI calls. On a bridge session the app therefore shows no queue chips, no "retrying (n/max)", and no other extensions' statuses, widgets or toasts. Extension dialogs are shown as "waiting for you in the terminal: <title>". Extension commands can't be run from the app, because `sendUserMessage` never dispatches them; the slash menu shows them disabled. Prompt templates and skills work (`expandPromptTemplates: true`). A manual compaction that another extension cancels leaves "compacting…" showing until the next run settles.
```

- [ ] **Step 7: Run everything**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A shared hub app/src/lib docs/superpowers/specs
git commit -m "feat(shared): bridge wire protocol and terminal prompt state; move the JSONL splitter to shared

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Bridge building blocks: wire translations and the socket client

**Files:**
- Create: `bridge/package.json`, `bridge/tsconfig.json`, `bridge/pi-modules.d.ts`, `bridge/wire.ts`, `bridge/client.ts`
- Create: `hub/test/support/recorder.ts`, `hub/test/support/fake-hub.ts`
- Create: `bridge/test/wire.test.ts`, `bridge/test/client.test.ts`
- Modify: `package.json` (root)

**Interfaces:**
- Consumes: `lineSplitter` from Task 1, and the `shared/src/bridge.ts` types.
- Produces:
  - From `bridge/wire.ts`:
    - `FORWARDED_EVENTS: readonly string[]`
    - `ModelLike`, `EntryLike`, `RawCommand`
    - `slimModel(m: ModelLike): ModelInfo`
    - `wireEvent(ev: PiEvent): PiEvent | null`
    - `sessionStats(entries: EntryLike[], ids: { sessionId: string; sessionFile?: string }, contextUsage: SessionStats["contextUsage"]): SessionStats`
    - `commandInfos(cmds: RawCommand[]): CommandInfo[]`
    - `extensionCommandName(text: string, cmds: RawCommand[]): string | null`
  - From `bridge/client.ts`: `socketPath(env?: NodeJS.ProcessEnv): string`, and `class BridgeClient` with `constructor(opts: BridgeClientOptions)`, `start(): void`, `send(msg: BridgeToHub): boolean` and `stop(): void`. `BridgeClientOptions` is `{ path; onOpen(); onMessage(msg: HubToBridge); minDelayMs?; maxDelayMs? }`.
  - From `hub/test/support/recorder.ts`: `class Recorder<T>` with `items`, `push`, `next(pred, timeoutMs?)` (ordered and consuming) and `waitFor(pred, timeoutMs?)` (any item, non-consuming).
  - From `hub/test/support/fake-hub.ts`: `fakeHub(path): Promise<FakeHub>`, where `FakeHub` is `{ messages: Recorder<any>; connections(): number; send(msg): void; dropClients(): void; close(): Promise<void> }`.

- [ ] **Step 1: Create the workspace**

`bridge/package.json`:

```json
{
	"name": "@pi-web/bridge",
	"private": true,
	"type": "module",
	"description": "pi extension: mirrors a terminal pi session to the pi-web hub",
	"keywords": ["pi-package"],
	"pi": { "extensions": ["./index.ts"] },
	"scripts": {
		"test": "node --test --test-concurrency=1 test/*.test.ts",
		"typecheck": "tsc -p tsconfig.json"
	},
	"devDependencies": { "typescript": "5.9.3", "@types/node": "26.6.5" }
}
```

`bridge/tsconfig.json`:

```json
{ "extends": "../tsconfig.base.json", "include": ["*.ts", "test"] }
```

`bridge/pi-modules.d.ts` holds type stubs for the modules pi provides to extensions at runtime. The bridge has no npm dependency on them:

```ts
// pi provides these modules to extensions at runtime (pi's virtual modules);
// the bridge declares only what it uses so it typechecks without depending on pi.

declare module "@earendil-works/pi-coding-agent" {
	export const VERSION: string;
	export function buildSessionContext(entries: unknown[], leafId?: string | null): { messages: unknown[] };
}

declare module "@earendil-works/pi-ai" {
	export function getSupportedThinkingLevels(model: unknown): string[];
}
```

In the root `package.json`, set `"workspaces": ["shared", "hub", "bridge", "app"]`, and make the scripts:

```json
		"test": "npm run test -w shared && npm run test -w hub && npm run test -w bridge && npm run test -w app",
		"typecheck": "npm run typecheck -w shared && npm run typecheck -w hub && npm run typecheck -w bridge && npm run typecheck -w app",
```

Run: `npm install`
Expected: the lockfile gains the `bridge` workspace and no new packages.

- [ ] **Step 2: Write the test helpers**

`hub/test/support/recorder.ts`:

```ts
// Collects messages from a stream and lets a test wait for one. `next` is
// ordered (each call starts after the last match); `waitFor` looks at everything.

export class Recorder<T> {
	readonly items: T[] = [];
	private cursor = 0;
	private waiters: Array<{ pred: (item: T) => boolean; ordered: boolean; resolve: (item: T) => void }> = [];

	push(item: T): void {
		this.items.push(item);
		for (const w of [...this.waiters]) {
			if (!w.pred(item)) continue;
			this.waiters.splice(this.waiters.indexOf(w), 1);
			if (w.ordered) this.cursor = this.items.length;
			w.resolve(item);
		}
	}

	next(pred: (item: T) => boolean, timeoutMs = 15_000): Promise<T> {
		const idx = this.items.findIndex((m, i) => i >= this.cursor && pred(m));
		if (idx >= 0) {
			this.cursor = idx + 1;
			return Promise.resolve(this.items[idx]);
		}
		return this.wait(pred, true, timeoutMs);
	}

	waitFor(pred: (item: T) => boolean, timeoutMs = 15_000): Promise<T> {
		const hit = this.items.find(pred);
		return hit !== undefined ? Promise.resolve(hit) : this.wait(pred, false, timeoutMs);
	}

	private wait(pred: (item: T) => boolean, ordered: boolean, timeoutMs: number): Promise<T> {
		return new Promise((resolve, reject) => {
			const w = {
				pred,
				ordered,
				resolve: (item: T) => {
					clearTimeout(timer);
					resolve(item);
				},
			};
			const timer = setTimeout(() => {
				this.waiters.splice(this.waiters.indexOf(w), 1);
				reject(new Error(`timed out waiting for a message; last seen: ${JSON.stringify(this.items.at(-1))?.slice(0, 300)}`));
			}, timeoutMs);
			this.waiters.push(w);
		});
	}
}
```

`hub/test/support/fake-hub.ts`:

```ts
// The hub's end of the bridge socket, for bridge tests: records what bridges
// send and lets the test send commands and notices back.

import { rmSync } from "node:fs";
import { type Socket, createServer } from "node:net";
import { lineSplitter } from "../../../shared/src/jsonl.ts";
import { Recorder } from "./recorder.ts";

export interface FakeHub {
	messages: Recorder<any>;
	connections(): number; // ever accepted
	send(msg: unknown): void; // to the most recent connection
	dropClients(): void;
	close(): Promise<void>;
}

export async function fakeHub(path: string): Promise<FakeHub> {
	const messages = new Recorder<any>();
	const sockets: Socket[] = [];
	let accepted = 0;
	const server = createServer((sock) => {
		accepted++;
		sockets.push(sock);
		sock.setEncoding("utf8");
		sock.on("data", lineSplitter((line) => messages.push(JSON.parse(line))));
		sock.on("error", () => {});
	});
	rmSync(path, { force: true });
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return {
		messages,
		connections: () => accepted,
		send: (msg) => sockets.at(-1)?.write(`${JSON.stringify(msg)}\n`),
		dropClients: () => {
			for (const s of sockets.splice(0)) s.destroy();
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of sockets.splice(0)) s.destroy();
				server.close(() => resolve());
			}),
	};
}
```

- [ ] **Step 3: Write the failing wire tests**

`bridge/test/wire.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvent, createConversation } from "../../shared/src/reducer.ts";
import { commandInfos, extensionCommandName, sessionStats, slimModel, wireEvent } from "../wire.ts";

const usage = (input: number, output: number, cost = 0) => ({ input, output, cacheRead: 1, cacheWrite: 2, cost: { total: cost } });

test("message_update loses message and partial, like RPC mode; the reducer still rebuilds the reply", () => {
	const partial = { role: "assistant", content: [{ type: "text", text: "Hel" }] };
	const conv = createConversation();
	const raw = [
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_update", message: { ...partial, usage: usage(3, 1) }, assistantMessageEvent: { type: "text_start", contentIndex: 0, partial } },
		{ type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel", partial } },
		{ type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo", partial } },
	];
	for (const ev of raw) {
		const w = wireEvent(ev);
		assert.ok(w);
		assert.equal("partial" in (w.assistantMessageEvent ?? {}), false);
		assert.equal("message" in w && w.type === "message_update", false);
		applyEvent(conv, w);
	}
	assert.deepEqual(conv.partial?.content, [{ type: "text", text: "Hello" }]);
	assert.deepEqual(conv.partial?.usage, usage(3, 1));
});

test("toolcall_start gains the call id and tool name from partial", () => {
	const partial = { content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] };
	const w = wireEvent({ type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial } });
	assert.deepEqual(w?.assistantMessageEvent, { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" });
});

test("system messages and pi-only events are not forwarded; heavy fields are dropped", () => {
	assert.equal(wireEvent({ type: "message_start", message: { role: "system", content: "prompt" } }), null);
	assert.equal(wireEvent({ type: "model_select", model: {} }), null);
	assert.equal(wireEvent({ type: "ui_prompt_start", kind: "select" }), null);
	assert.deepEqual(wireEvent({ type: "agent_end", messages: [1, 2, 3] }), { type: "agent_end" });
	assert.deepEqual(wireEvent({ type: "turn_end", turnIndex: 2, message: {}, toolResults: [], context: {} }), { type: "turn_end", turnIndex: 2 });
	assert.deepEqual(wireEvent({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: { content: [] }, isError: false }), {
		type: "tool_execution_end",
		toolCallId: "c",
		toolName: "bash",
		result: { content: [] },
		isError: false,
	});
});

test("compaction events are synthesized from the session compaction hooks", () => {
	assert.deepEqual(wireEvent({ type: "session_before_compact", reason: "manual", preparation: {}, branchEntries: [] }), { type: "compaction_start", reason: "manual" });
	assert.deepEqual(wireEvent({ type: "session_compact", reason: "threshold", willRetry: false, compactionEntry: {} }), { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
	assert.deepEqual(wireEvent({ type: "session_compact_failed", reason: "manual", aborted: true, willRetry: false, errorMessage: "nope" }), {
		type: "compaction_end",
		reason: "manual",
		aborted: true,
		willRetry: false,
		errorMessage: "nope",
	});
});

test("stats sum usage the way pi's getSessionStats does", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text" }, { type: "toolCall" }, { type: "toolCall" }], usage: usage(10, 5, 0.5) } },
		{ type: "message", message: { role: "toolResult", content: [] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text" }] } }, // aborted before usage
		{ type: "compaction", usage: usage(100, 20, 1) },
		{ type: "model_change" },
	];
	const stats = sessionStats(entries, { sessionId: "s", sessionFile: "/f" }, { tokens: 7, contextWindow: 1000, percent: 0.7 });
	assert.deepEqual(stats, {
		sessionFile: "/f",
		sessionId: "s",
		userMessages: 1,
		assistantMessages: 2,
		toolCalls: 2,
		toolResults: 1,
		totalMessages: 4,
		tokens: { input: 110, output: 25, cacheRead: 2, cacheWrite: 4, total: 141 },
		cost: 1.5,
		contextUsage: { tokens: 7, contextWindow: 1000, percent: 0.7 },
	});
});

test("models are slimmed to the app's ModelInfo; command lists keep pi's three sources", () => {
	assert.deepEqual(slimModel({ id: "a", name: "A", provider: "p", reasoning: true, input: ["text", "image"], contextWindow: 9, maxTokens: 3, api: "x", baseUrl: "y" } as never), {
		id: "a",
		name: "A",
		provider: "p",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 9,
		maxTokens: 3,
		cost: undefined,
	});
	const cmds = [
		{ name: "ask", description: "d", source: "extension", sourceInfo: {} },
		{ name: "greet", source: "prompt" },
		{ name: "skill:demo", source: "skill" },
		{ name: "weird", source: "other" },
	];
	assert.deepEqual(commandInfos(cmds), [
		{ name: "ask", description: "d", source: "extension" },
		{ name: "greet", description: undefined, source: "prompt" },
		{ name: "skill:demo", description: undefined, source: "skill" },
	]);
	assert.equal(extensionCommandName("/ask now", cmds), "ask");
	assert.equal(extensionCommandName("  /ask", cmds), "ask");
	assert.equal(extensionCommandName("/greet Bob", cmds), null);
	assert.equal(extensionCommandName("tell me about /ask", cmds), null);
});
```

Run: `npm test -w bridge`
Expected: FAIL, because `../wire.ts` doesn't exist.

- [ ] **Step 4: Implement `bridge/wire.ts`**

```ts
// Pure translations from pi's in-process extension shapes to the wire shapes
// the hub and app already know from RPC mode (pi docs/json.md).

import type { CommandInfo, ModelInfo, PiEvent, SessionStats } from "../shared/src/protocol.ts";

// Every pi event the bridge listens to. Its handlers only observe.
export const FORWARDED_EVENTS = [
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"session_before_compact",
	"session_compact",
	"session_compact_failed",
	"ui_prompt_start",
	"ui_prompt_end",
	"model_select",
	"thinking_level_select",
	"session_info_changed",
] as const;

export interface ModelLike {
	id: string;
	name?: string;
	provider: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: ModelInfo["cost"];
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export interface EntryLike {
	type: string;
	usage?: UsageLike;
	message?: { role: string; content?: unknown; usage?: UsageLike };
}

export interface RawCommand {
	name: string;
	description?: string;
	source: string;
}

export function slimModel(m: ModelLike): ModelInfo {
	return {
		id: m.id,
		name: m.name ?? m.id,
		provider: m.provider,
		reasoning: Boolean(m.reasoning),
		input: m.input ?? ["text"],
		contextWindow: m.contextWindow ?? 0,
		maxTokens: m.maxTokens ?? 0,
		cost: m.cost,
	};
}

// RPC mode sends message_update as {usage, assistantMessageEvent} with the
// accumulated `partial` removed (pi's toJsonEvent); the bridge matches it.
export function wireEvent(ev: PiEvent): PiEvent | null {
	switch (ev.type) {
		case "agent_start":
		case "agent_end":
		case "agent_settled":
			return { type: ev.type };
		case "turn_start":
			return { type: "turn_start", turnIndex: ev.turnIndex, timestamp: ev.timestamp };
		case "turn_end":
			return { type: "turn_end", turnIndex: ev.turnIndex };
		case "message_start":
		case "message_end":
			return ev.message?.role === "system" ? null : { type: ev.type, message: ev.message };
		case "message_update":
			return { type: "message_update", usage: ev.message?.usage, assistantMessageEvent: stripPartial(ev.assistantMessageEvent) };
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			return { ...ev };
		case "session_before_compact":
			return { type: "compaction_start", reason: ev.reason };
		case "session_compact":
			return { type: "compaction_end", reason: ev.reason, aborted: false, willRetry: ev.willRetry };
		case "session_compact_failed":
			return { type: "compaction_end", reason: ev.reason, aborted: ev.aborted, willRetry: ev.willRetry, errorMessage: ev.errorMessage };
		default:
			return null;
	}
}

function stripPartial(d: any): any {
	if (!d || typeof d !== "object" || !("partial" in d)) return d;
	const { partial, ...delta } = d;
	if (d.type !== "toolcall_start") return delta;
	const call = partial?.content?.[d.contentIndex];
	return { ...delta, id: call?.id, toolName: call?.name };
}

// The same totals as pi's AgentSession.getSessionStats(), which extensions can't call.
export function sessionStats(entries: EntryLike[], ids: { sessionId: string; sessionFile?: string }, contextUsage: SessionStats["contextUsage"]): SessionStats {
	const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const add = (u?: UsageLike) => {
		if (!u) return;
		t.input += u.input ?? 0;
		t.output += u.output ?? 0;
		t.cacheRead += u.cacheRead ?? 0;
		t.cacheWrite += u.cacheWrite ?? 0;
		t.cost += u.cost?.total ?? 0;
	};
	const n = { user: 0, assistant: 0, toolResults: 0, total: 0, toolCalls: 0 };
	for (const e of entries) {
		if (e.type === "usage" || ((e.type === "branch_summary" || e.type === "compaction") && e.usage)) add(e.usage);
		if (e.type !== "message" || !e.message) continue;
		n.total++;
		const m = e.message;
		if (m.role === "user") n.user++;
		else if (m.role === "toolResult") {
			n.toolResults++;
			add(m.usage);
		} else if (m.role === "assistant") {
			n.assistant++;
			if (Array.isArray(m.content)) n.toolCalls += m.content.filter((c) => (c as { type?: string }).type === "toolCall").length;
			add(m.usage);
		}
	}
	return {
		sessionFile: ids.sessionFile,
		sessionId: ids.sessionId,
		userMessages: n.user,
		assistantMessages: n.assistant,
		toolCalls: n.toolCalls,
		toolResults: n.toolResults,
		totalMessages: n.total,
		tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, total: t.input + t.output + t.cacheRead + t.cacheWrite },
		cost: t.cost,
		contextUsage,
	};
}

const SOURCES = new Set(["extension", "prompt", "skill"]);

export function commandInfos(cmds: RawCommand[]): CommandInfo[] {
	return cmds.filter((c) => SOURCES.has(c.source)).map((c) => ({ name: c.name, description: c.description, source: c.source as CommandInfo["source"] }));
}

// pi.sendUserMessage never runs extension commands; it would send "/ask" to the model.
export function extensionCommandName(text: string, cmds: RawCommand[]): string | null {
	const m = text.trim().match(/^\/(\S+)/);
	return m && cmds.some((c) => c.source === "extension" && c.name === m[1]) ? m[1] : null;
}
```

Run: `npm test -w bridge`
Expected: wire tests PASS. The client tests don't exist yet.

- [ ] **Step 5: Write the failing client tests**

`bridge/test/client.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fakeHub } from "../../hub/test/support/fake-hub.ts";
import { Recorder } from "../../hub/test/support/recorder.ts";
import { BridgeClient, socketPath } from "../client.ts";

test("socket path: env override, then data dir, then ~/.config/pi-web", () => {
	assert.equal(socketPath({ PI_WEB_BRIDGE_SOCKET: "/x/s.sock", PI_WEB_DATA_DIR: "/d" }), "/x/s.sock");
	assert.equal(socketPath({ PI_WEB_DATA_DIR: "/d" }), "/d/bridge.sock");
	assert.match(socketPath({}), /\/\.config\/pi-web\/bridge\.sock$/);
});

function setup(t: import("node:test").TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-client-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "bridge.sock");
	const opened: number[] = [];
	const received = new Recorder<any>();
	const client = new BridgeClient({ path, minDelayMs: 20, maxDelayMs: 80, onOpen: () => opened.push(Date.now()), onMessage: (m) => received.push(m) });
	t.after(() => client.stop());
	return { path, client, opened, received };
}

test("with no hub it keeps retrying quietly, then connects once the hub appears", async (t) => {
	const { path, client, opened } = setup(t);
	client.start();
	assert.equal(client.send({ type: "bye", reason: "quit" }), false); // nothing to send to yet
	await sleep(150);
	assert.equal(opened.length, 0);
	const hub = await fakeHub(path);
	t.after(() => hub.close());
	for (let i = 0; i < 50 && opened.length === 0; i++) await sleep(10);
	assert.equal(opened.length, 1);
	assert.equal(client.send({ type: "bye", reason: "quit" }), true);
	assert.deepEqual(await hub.messages.next((m) => m.type === "bye"), { type: "bye", reason: "quit" });
});

test("messages from the hub arrive parsed, one per line", async (t) => {
	const { path, client, received } = setup(t);
	const hub = await fakeHub(path);
	t.after(() => hub.close());
	client.start();
	for (let i = 0; i < 50 && hub.connections() === 0; i++) await sleep(10);
	hub.send({ type: "notice", text: "a b" }); // U+2028 must not split the record
	hub.send({ type: "cmd", id: "1", command: { type: "abort" } });
	assert.deepEqual(await received.next((m) => m.type === "notice"), { type: "notice", text: "a b" });
	assert.equal((await received.next((m) => m.type === "cmd")).id, "1");
});

test("a dropped connection reconnects and opens again; stop() ends retrying", async (t) => {
	const { path, client, opened } = setup(t);
	const hub = await fakeHub(path);
	t.after(() => hub.close());
	client.start();
	for (let i = 0; i < 50 && opened.length < 1; i++) await sleep(10);
	hub.dropClients();
	for (let i = 0; i < 100 && opened.length < 2; i++) await sleep(10);
	assert.equal(opened.length, 2);
	client.stop();
	hub.dropClients();
	await sleep(200);
	assert.equal(opened.length, 2);
	assert.equal(hub.connections(), 2);
});
```

Run: `npm test -w bridge`
Expected: FAIL, because `../client.ts` doesn't exist.

- [ ] **Step 6: Implement `bridge/client.ts`**

```ts
// The bridge's socket to the hub. Never throws and never prints: while the hub
// is down it retries quietly, 1s doubling to 60s (spec §7). Timers are unref'd
// so a waiting bridge never keeps pi alive.

import { type Socket, createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeToHub, HubToBridge } from "../shared/src/bridge.ts";
import { lineSplitter } from "../shared/src/jsonl.ts";

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_WEB_BRIDGE_SOCKET || join(env.PI_WEB_DATA_DIR || join(homedir(), ".config", "pi-web"), "bridge.sock");
}

export interface BridgeClientOptions {
	path: string;
	onOpen(): void;
	onMessage(msg: HubToBridge): void;
	minDelayMs?: number;
	maxDelayMs?: number;
}

export class BridgeClient {
	private opts: BridgeClientOptions;
	private sock: Socket | null = null;
	private ready = false;
	private stopped = false;
	private timer: NodeJS.Timeout | null = null;
	private delay: number;

	constructor(opts: BridgeClientOptions) {
		this.opts = opts;
		this.delay = opts.minDelayMs ?? 1000;
	}

	start(): void {
		this.open();
	}

	send(msg: BridgeToHub): boolean {
		if (!this.sock || !this.ready) return false;
		this.sock.write(`${JSON.stringify(msg)}\n`);
		return true;
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.sock?.end();
		this.sock = null;
		this.ready = false;
	}

	private open(): void {
		if (this.stopped) return;
		const sock = createConnection(this.opts.path);
		this.sock = sock;
		this.ready = false;
		sock.setEncoding("utf8");
		sock.on("connect", () => {
			if (this.sock !== sock) return;
			this.ready = true;
			this.delay = this.opts.minDelayMs ?? 1000;
			this.opts.onOpen();
		});
		sock.on(
			"data",
			lineSplitter((line) => {
				let msg: HubToBridge;
				try {
					msg = JSON.parse(line);
				} catch {
					return;
				}
				this.opts.onMessage(msg);
			}),
		);
		sock.on("error", () => {}); // "close" follows; retrying is the only reaction
		sock.on("close", () => {
			if (this.sock !== sock) return;
			this.sock = null;
			this.ready = false;
			this.retry();
		});
	}

	private retry(): void {
		if (this.stopped || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.open();
		}, this.delay);
		this.timer.unref();
		this.delay = Math.min(this.delay * 2, this.opts.maxDelayMs ?? 60_000);
	}
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npm test -w bridge && npm run typecheck -w bridge`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json bridge hub/test/support/recorder.ts hub/test/support/fake-hub.ts
git commit -m "feat(bridge): wire translations from pi's extension events, and a quiet reconnecting socket client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `BridgeSession`: one bridged pi session

**Files:**
- Create: `bridge/session.ts`, `bridge/test/session.test.ts`

**Interfaces:**
- Consumes: `BridgeClient` and the `wire.ts` functions from Task 2; the `shared/src/bridge.ts` types.
- Produces, from `bridge/session.ts`:
  - `PiLike`, `CtxLike`, `UserContent`, `BridgeEnv`.
  - `class BridgeSession` with:
    - `constructor(pi: PiLike, ctx: CtxLike, env: BridgeEnv)`
    - `start(): void`
    - `stop(reason: ByeReason): void`
    - `onPiEvent(ev: PiEvent, ctx: CtxLike): void`
    - `run(cmd: BridgeCommand): Promise<BridgeResult>`
  - `BridgeEnv` is `{ socketPath; piVersion; buildMessages(entries, leafId): AgentMessage[]; thinkingLevels(model): ThinkingLevel[]; pid?; minDelayMs?; maxDelayMs? }`.

- [ ] **Step 1: Write the failing tests**

`bridge/test/session.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { AgentMessage } from "../../shared/src/protocol.ts";
import { fakeHub } from "../../hub/test/support/fake-hub.ts";
import { BridgeSession, type CtxLike, type PiLike } from "../session.ts";
import type { EntryLike, ModelLike } from "../wire.ts";

const MODELS: ModelLike[] = [
	{ id: "a", name: "A", provider: "p", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100 },
	{ id: "nokey", name: "No key", provider: "p", reasoning: false, input: ["text"], contextWindow: 2000, maxTokens: 100 },
];

function fakes() {
	const calls: unknown[][] = [];
	const world = { idle: true, name: undefined as string | undefined, thinking: "medium", model: MODELS[0] as ModelLike | undefined, compact: "ok" as "ok" | "fail" };
	const entries: EntryLike[] = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "yo" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } } },
	];
	const pi: PiLike = {
		sendUserMessage: (content, options) => void calls.push(["send", content, options]),
		setModel: async (m) => {
			calls.push(["setModel", m.id]);
			if (m.id === "nokey") return false;
			world.model = m;
			return true;
		},
		getThinkingLevel: () => world.thinking as never,
		setThinkingLevel: (level) => void (world.thinking = level),
		getSessionName: () => world.name,
		setSessionName: (name) => void (world.name = name),
		getCommands: () => [
			{ name: "ask", source: "extension" },
			{ name: "greet", description: "greet", source: "prompt" },
		],
	};
	const ctx: CtxLike = {
		cwd: "/work",
		hasUI: true,
		ui: { notify: (message, type) => void calls.push(["notify", message, type]) },
		get model() {
			return world.model;
		},
		sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => "/s/sess-1.jsonl", getLeafId: () => "leaf", getEntries: () => entries },
		modelRegistry: { getAvailable: () => MODELS, find: (provider, id) => MODELS.find((m) => m.provider === provider && m.id === id) },
		isIdle: () => world.idle,
		hasPendingMessages: () => false,
		abort: () => void calls.push(["abort"]),
		getContextUsage: () => ({ tokens: 15, contextWindow: 1000, percent: 1.5 }),
		compact: (o) => {
			calls.push(["compact", o.customInstructions]);
			setTimeout(() => (world.compact === "ok" ? o.onComplete?.({}) : o.onError?.(new Error("Nothing to compact"))), 5);
		},
	};
	return { pi, ctx, calls, world };
}

async function setup(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-session-"));
	const path = join(dir, "bridge.sock");
	const hub = await fakeHub(path);
	const f = fakes();
	const session = new BridgeSession(f.pi, f.ctx, {
		socketPath: path,
		piVersion: "1.0.2",
		pid: 4321,
		minDelayMs: 20,
		maxDelayMs: 50,
		buildMessages: (entries) => entries.map((e) => e.message as AgentMessage),
		thinkingLevels: (model) => (model?.reasoning ? ["off", "low", "high"] : ["off"]),
	});
	t.after(async () => {
		session.stop("quit");
		await hub.close();
		rmSync(dir, { recursive: true, force: true });
	});
	session.start();
	const hello = await hub.messages.next((m) => m.type === "hello");
	return { ...f, hub, session, hello };
}

test("hello carries the ids and a full sync: state, stats, models, commands, messages", async (t) => {
	const { hello } = await setup(t);
	assert.equal(hello.protocol, 1);
	assert.deepEqual([hello.sessionId, hello.sessionFile, hello.cwd, hello.pid, hello.piVersion], ["sess-1", "/s/sess-1.jsonl", "/work", 4321, "1.0.2"]);
	assert.equal(hello.prompt, null);
	assert.equal(hello.sync.state.model.id, "a");
	assert.equal(hello.sync.state.thinkingLevel, "medium");
	assert.equal(hello.sync.state.isStreaming, false);
	assert.equal(hello.sync.stats.tokens.total, 15);
	assert.equal(hello.sync.stats.cost, 0.25);
	assert.deepEqual(hello.sync.stats.contextUsage, { tokens: 15, contextWindow: 1000, percent: 1.5 });
	assert.deepEqual(hello.sync.thinkingLevels, ["off", "low", "high"]);
	assert.deepEqual(hello.sync.models.map((m: { id: string }) => m.id), ["a", "nokey"]);
	assert.deepEqual(hello.sync.commands.map((c: { name: string }) => c.name), ["ask", "greet"]);
	assert.equal(hello.sync.messages.length, 2);
});

test("pi events are forwarded in RPC shape; turns and settles push a state sync", async (t) => {
	const { hub, session, ctx, world } = await setup(t);
	world.idle = false;
	session.onPiEvent({ type: "agent_start" }, ctx);
	session.onPiEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} } }, ctx);
	session.onPiEvent({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);
	assert.deepEqual((await hub.messages.next((m) => m.type === "event")).event, { type: "agent_start" });
	assert.deepEqual((await hub.messages.next((m) => m.type === "event")).event, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } }); // undefined usage is dropped by JSON
	assert.deepEqual((await hub.messages.next((m) => m.type === "event")).event, { type: "turn_end", turnIndex: 0 });
	const sync = await hub.messages.next((m) => m.type === "sync");
	assert.equal(sync.sync.state.isStreaming, true);
	assert.equal(sync.sync.messages, undefined); // state only
	world.idle = true;
	session.onPiEvent({ type: "agent_settled" }, ctx);
	assert.equal((await hub.messages.next((m) => m.type === "sync")).sync.state.isStreaming, false);
});

test("compaction: start and end events, isCompacting while it runs, and a full sync afterwards", async (t) => {
	const { hub, session, ctx } = await setup(t);
	session.onPiEvent({ type: "session_before_compact", reason: "manual", preparation: {}, branchEntries: [] }, ctx);
	assert.deepEqual((await hub.messages.next((m) => m.type === "event")).event, { type: "compaction_start", reason: "manual" });
	session.onPiEvent({ type: "turn_end", turnIndex: 0 }, ctx);
	assert.equal((await hub.messages.next((m) => m.type === "sync")).sync.state.isCompacting, true);
	session.onPiEvent({ type: "session_compact", reason: "manual", willRetry: false, compactionEntry: {} }, ctx);
	assert.equal((await hub.messages.next((m) => m.type === "event")).event.type, "compaction_end");
	const full = await hub.messages.next((m) => m.type === "sync");
	assert.equal(full.sync.state.isCompacting, false);
	assert.equal(full.sync.messages.length, 2);
});

test("a compaction still marked running when the agent settles is closed out", async (t) => {
	const { hub, session, ctx } = await setup(t);
	session.onPiEvent({ type: "session_before_compact", reason: "threshold" }, ctx);
	session.onPiEvent({ type: "agent_settled" }, ctx);
	await hub.messages.next((m) => m.type === "event" && m.event.type === "compaction_start");
	assert.deepEqual((await hub.messages.next((m) => m.type === "event" && m.event.type === "compaction_end")).event, { type: "compaction_end", reason: "threshold", aborted: true, willRetry: false });
	assert.equal((await hub.messages.next((m) => m.type === "sync")).sync.state.isCompacting, false);
});

test("terminal dialogs open and close as prompt_state", async (t) => {
	const { hub, session, ctx } = await setup(t);
	session.onPiEvent({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Pick one" }, ctx);
	assert.deepEqual((await hub.messages.next((m) => m.type === "prompt_state")).prompt, { kind: "select", title: "Pick one" });
	session.onPiEvent({ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Pick one" }, ctx);
	assert.equal((await hub.messages.next((m) => m.type === "prompt_state")).prompt, null);
});

test("prompts: plain send when idle, follow-up while busy, steer on request, images as content blocks", async (t) => {
	const { session, calls, world } = await setup(t);
	assert.deepEqual(await session.run({ type: "prompt", text: "/greet Bob", mode: "send" }), { ok: true });
	world.idle = false;
	await session.run({ type: "prompt", text: "more", mode: "send" });
	await session.run({ type: "prompt", text: "turn left", mode: "steer" });
	await session.run({ type: "prompt", text: "look", images: [{ data: "AAAA", mimeType: "image/png" }], mode: "followUp" });
	assert.deepEqual(
		calls.filter((c) => c[0] === "send"),
		[
			["send", "/greet Bob", { expandPromptTemplates: true }],
			["send", "more", { expandPromptTemplates: true, deliverAs: "followUp" }],
			["send", "turn left", { expandPromptTemplates: true, deliverAs: "steer" }],
			["send", [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], { expandPromptTemplates: true, deliverAs: "followUp" }],
		],
	);
});

test("an extension command is refused instead of being sent to the model as text", async (t) => {
	const { session, calls } = await setup(t);
	const r = await session.run({ type: "prompt", text: "/ask", mode: "send" });
	assert.equal(r.ok, false);
	assert.match(r.error ?? "", /\/ask is an extension command\. Run it in the terminal\./);
	assert.equal(calls.filter((c) => c[0] === "send").length, 0);
});

test("model, thinking, rename, abort and compact run through the extension API", async (t) => {
	const { session, calls, world } = await setup(t);
	assert.deepEqual(await session.run({ type: "set_model", provider: "p", modelId: "missing" }), { ok: false, error: "Model not found: p/missing" });
	assert.deepEqual(await session.run({ type: "set_model", provider: "p", modelId: "nokey" }), { ok: false, error: "No API key for p/nokey" });
	assert.deepEqual(await session.run({ type: "set_model", provider: "p", modelId: "a" }), { ok: true });
	assert.deepEqual(await session.run({ type: "set_thinking", level: "high" }), { ok: true });
	assert.equal(world.thinking, "high");
	assert.deepEqual(await session.run({ type: "rename", name: "  " }), { ok: false, error: "Session name cannot be empty" });
	assert.deepEqual(await session.run({ type: "rename", name: " katsu " }), { ok: true });
	assert.equal(world.name, "katsu");
	assert.deepEqual(await session.run({ type: "abort" }), { ok: true });
	assert.deepEqual(await session.run({ type: "compact", instructions: "short" }), { ok: true });
	world.compact = "fail";
	assert.deepEqual(await session.run({ type: "compact" }), { ok: false, error: "Nothing to compact" });
	assert.deepEqual(
		calls.filter((c) => c[0] === "abort" || c[0] === "compact"),
		[["abort"], ["compact", "short"], ["compact", undefined]],
	);
});

test("commands from the hub are answered with a result; notices go to the terminal", async (t) => {
	const { hub, calls } = await setup(t);
	hub.send({ type: "cmd", id: "7", command: { type: "rename", name: "from the hub" } });
	assert.deepEqual(await hub.messages.next((m) => m.type === "result"), { type: "result", id: "7", ok: true });
	hub.send({ type: "notice", text: "hello terminal" });
	for (let i = 0; i < 50 && !calls.some((c) => c[0] === "notify"); i++) await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(
		calls.find((c) => c[0] === "notify"),
		["notify", "hello terminal", "info"],
	);
});

test("after the hub restarts, the bridge reconnects and introduces itself again in full", async (t) => {
	const { hub } = await setup(t);
	hub.dropClients();
	const again = await hub.messages.next((m) => m.type === "hello");
	assert.equal(again.sessionId, "sess-1");
	assert.equal(again.sync.messages.length, 2);
});

test("stop says bye with pi's reason", async (t) => {
	const { hub, session } = await setup(t);
	session.stop("new");
	assert.deepEqual(await hub.messages.next((m) => m.type === "bye"), { type: "bye", reason: "new" });
});
```

Run: `npm test -w bridge`
Expected: FAIL, because `../session.ts` doesn't exist.

- [ ] **Step 2: Implement `bridge/session.ts`**

```ts
// One bridged pi session: introduces it to the hub, streams its events, keeps
// the hub's state current, and runs the app's commands through the extension
// API. A new BridgeSession starts on every session_start, because a TUI /new,
// /resume or /fork replaces pi's extension runtime and invalidates the old ctx.

import { BRIDGE_PROTOCOL, type BridgeCommand, type BridgeResult, type BridgeSync, type ByeReason, type FullSync, type HubToBridge } from "../shared/src/bridge.ts";
import type { AgentMessage, PiEvent, SessionStats, TerminalPrompt, ThinkingLevel } from "../shared/src/protocol.ts";
import { BridgeClient } from "./client.ts";
import { type EntryLike, type ModelLike, type RawCommand, commandInfos, extensionCommandName, sessionStats, slimModel, wireEvent } from "./wire.ts";

export type UserContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// The parts of pi's ExtensionAPI the bridge uses.
export interface PiLike {
	sendUserMessage(content: string | UserContent[], options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
	setModel(model: ModelLike): Promise<boolean>;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
	getSessionName(): string | undefined;
	setSessionName(name: string): void;
	getCommands(): RawCommand[];
}

// The parts of pi's ExtensionContext the bridge uses.
export interface CtxLike {
	cwd: string;
	hasUI: boolean;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
	model: ModelLike | undefined;
	sessionManager: { getSessionId(): string; getSessionFile(): string | undefined; getLeafId(): string | null; getEntries(): EntryLike[] };
	modelRegistry: { getAvailable(): ModelLike[]; find(provider: string, modelId: string): ModelLike | undefined };
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	abort(): void;
	getContextUsage(): SessionStats["contextUsage"] | undefined;
	compact(options: { customInstructions?: string; onComplete?: (result: unknown) => void; onError?: (error: Error) => void }): void;
}

export interface BridgeEnv {
	socketPath: string;
	piVersion: string;
	buildMessages(entries: EntryLike[], leafId: string | null): AgentMessage[];
	thinkingLevels(model: ModelLike | undefined): ThinkingLevel[];
	pid?: number;
	minDelayMs?: number;
	maxDelayMs?: number;
}

// Events after which the hub needs fresh state (model, thinking, name, stats).
const SYNC_AFTER = new Set(["turn_end", "agent_settled", "session_compact_failed", "model_select", "thinking_level_select", "session_info_changed"]);

export class BridgeSession {
	private pi: PiLike;
	private ctx: CtxLike;
	private env: BridgeEnv;
	private client: BridgeClient;
	private compacting: { reason: string } | null = null;
	private prompts: TerminalPrompt[] = [];

	constructor(pi: PiLike, ctx: CtxLike, env: BridgeEnv) {
		this.pi = pi;
		this.ctx = ctx;
		this.env = env;
		this.client = new BridgeClient({
			path: env.socketPath,
			minDelayMs: env.minDelayMs,
			maxDelayMs: env.maxDelayMs,
			onOpen: () => this.hello(),
			onMessage: (m) => void this.onHubMessage(m),
		});
	}

	start(): void {
		this.client.start();
	}

	stop(reason: ByeReason): void {
		this.client.send({ type: "bye", reason });
		this.client.stop();
	}

	onPiEvent(ev: PiEvent, ctx: CtxLike): void {
		this.ctx = ctx;
		if (ev.type === "session_before_compact") this.compacting = { reason: ev.reason };
		if (ev.type === "session_compact" || ev.type === "session_compact_failed") this.compacting = null;
		const wire = wireEvent(ev);
		if (wire) this.client.send({ type: "event", event: wire });
		switch (ev.type) {
			case "ui_prompt_start":
				this.prompts.push({ kind: String(ev.kind), title: String(ev.title ?? "") });
				this.client.send({ type: "prompt_state", prompt: this.prompts.at(-1) ?? null });
				return;
			case "ui_prompt_end":
				this.prompts.pop();
				this.client.send({ type: "prompt_state", prompt: this.prompts.at(-1) ?? null });
				return;
			case "session_compact":
				this.client.send({ type: "sync", sync: this.fullSync() });
				return;
			case "agent_settled":
				// Nothing more runs after a settle, so a compaction that never reported back was cancelled.
				if (this.compacting) {
					this.client.send({ type: "event", event: { type: "compaction_end", reason: this.compacting.reason, aborted: true, willRetry: false } });
					this.compacting = null;
				}
				break;
		}
		if (SYNC_AFTER.has(ev.type)) this.client.send({ type: "sync", sync: this.baseSync() });
	}

	async run(cmd: BridgeCommand): Promise<BridgeResult> {
		try {
			switch (cmd.type) {
				case "prompt": {
					const ext = extensionCommandName(cmd.text, this.pi.getCommands());
					if (ext) return { ok: false, error: `/${ext} is an extension command. Run it in the terminal.` };
					const content: string | UserContent[] = cmd.images?.length
						? [{ type: "text", text: cmd.text }, ...cmd.images.map((i): UserContent => ({ type: "image", data: i.data, mimeType: i.mimeType }))]
						: cmd.text;
					const deliverAs = cmd.mode !== "send" ? cmd.mode : this.ctx.isIdle() ? undefined : "followUp";
					this.pi.sendUserMessage(content, { expandPromptTemplates: true, ...(deliverAs ? { deliverAs } : {}) });
					return { ok: true };
				}
				case "abort":
					this.ctx.abort();
					return { ok: true };
				case "set_model": {
					const model = this.ctx.modelRegistry.find(cmd.provider, cmd.modelId);
					if (!model) return { ok: false, error: `Model not found: ${cmd.provider}/${cmd.modelId}` };
					return (await this.pi.setModel(model)) ? { ok: true } : { ok: false, error: `No API key for ${cmd.provider}/${cmd.modelId}` };
				}
				case "set_thinking":
					this.pi.setThinkingLevel(cmd.level);
					return { ok: true };
				case "rename": {
					const name = cmd.name.trim();
					if (!name) return { ok: false, error: "Session name cannot be empty" };
					this.pi.setSessionName(name);
					return { ok: true };
				}
				case "compact":
					return await new Promise<BridgeResult>((resolve) => {
						this.ctx.compact({
							customInstructions: cmd.instructions,
							onComplete: () => resolve({ ok: true }),
							onError: (err) => resolve({ ok: false, error: err.message }),
						});
					});
			}
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	private async onHubMessage(msg: HubToBridge): Promise<void> {
		if (msg.type === "notice") {
			if (this.ctx.hasUI) this.ctx.ui.notify(msg.text, "info");
			return;
		}
		if (msg.type !== "cmd") return;
		const result = await this.run(msg.command);
		this.client.send({ type: "result", id: msg.id, ...result });
	}

	private hello(): void {
		const sm = this.ctx.sessionManager;
		this.client.send({
			type: "hello",
			protocol: BRIDGE_PROTOCOL,
			sessionId: sm.getSessionId(),
			sessionFile: sm.getSessionFile() ?? null,
			cwd: this.ctx.cwd,
			pid: this.env.pid ?? process.pid,
			piVersion: this.env.piVersion,
			sync: this.fullSync(),
			prompt: this.prompts.at(-1) ?? null,
		});
	}

	private baseSync(): BridgeSync {
		const sm = this.ctx.sessionManager;
		const sessionId = sm.getSessionId();
		const sessionFile = sm.getSessionFile();
		const stats = sessionStats(sm.getEntries(), { sessionId, sessionFile }, this.ctx.getContextUsage());
		const model = this.ctx.model;
		return {
			state: {
				model: model ? slimModel(model) : null,
				thinkingLevel: this.pi.getThinkingLevel(),
				isStreaming: !this.ctx.isIdle(),
				isCompacting: this.compacting !== null,
				sessionName: this.pi.getSessionName(),
				sessionId,
				sessionFile,
				messageCount: stats.totalMessages,
				pendingMessageCount: this.ctx.hasPendingMessages() ? 1 : 0,
				autoCompactionEnabled: true,
			},
			stats,
			thinkingLevels: this.env.thinkingLevels(model),
		};
	}

	private fullSync(): FullSync {
		const sm = this.ctx.sessionManager;
		return {
			...this.baseSync(),
			models: this.ctx.modelRegistry.getAvailable().map(slimModel),
			commands: commandInfos(this.pi.getCommands()),
			messages: this.env.buildMessages(sm.getEntries(), sm.getLeafId()),
		};
	}
}
```

- [ ] **Step 3: Run tests and typecheck**

Run: `npm test -w bridge && npm run typecheck -w bridge`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add bridge/session.ts bridge/test/session.test.ts
git commit -m "feat(bridge): BridgeSession streams a pi session to the hub and runs the app's commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The pi extension, against real pi

**Files:**
- Create: `bridge/index.ts`, `hub/test/support/terminal-pi.ts`, `bridge/test/extension.test.ts`

**Interfaces:**
- Consumes: `BridgeSession` (Task 3), `FORWARDED_EVENTS` (Task 2), `fakeHub` and `Recorder` (Task 2), and the existing `startFakeModel` and `makePiEnv` from Plan 1.
- Produces:
  - `bridge/index.ts`: a default export `piWebBridge(pi)`, the extension factory. It imports pi's virtual modules, so only pi can load it; node tests import `client.ts`, `session.ts` and `wire.ts` instead.
  - `hub/test/support/terminal-pi.ts`:
    - `BRIDGE_ENTRY: string`, the absolute path of `bridge/index.ts`.
    - `startTerminalPi(opts: TerminalPiOptions): TerminalPi`. The options are `{ piBin; cwd; env; socketPath; sessionFile?; loadBridge?: boolean (default true); extraEnv? }`.
    - `TerminalPi` is `{ proc; pid; records: Recorder<any>; stderr(); send(cmd); call(cmd): Promise<any>; quit(): Promise<void> }`.

- [ ] **Step 1: Write the terminal-pi helper**

A "terminal" pi in tests is `pi --mode rpc` with the bridge loaded. It is driven over stdin the way a person drives the TUI, and pi runs extensions the same way in both modes. `hub/test/support/terminal-pi.ts`:

```ts
// A stand-in for pi running in a terminal: `pi --mode rpc` with the bridge
// extension loaded, driven over stdin the way a person drives the TUI. Its
// stdout records (events, responses, extension UI requests) are recorded.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lineSplitter } from "../../../shared/src/jsonl.ts";
import { Recorder } from "./recorder.ts";

export const BRIDGE_ENTRY = fileURLToPath(new URL("../../../bridge/index.ts", import.meta.url));

export interface TerminalPiOptions {
	piBin: string;
	cwd: string;
	env: Record<string, string>; // e.g. PI_CODING_AGENT_DIR
	socketPath: string;
	sessionFile?: string;
	loadBridge?: boolean; // default true; false when settings.json already loads it
	extraEnv?: Record<string, string>;
}

export interface TerminalPi {
	proc: ChildProcessWithoutNullStreams;
	pid: number;
	records: Recorder<any>;
	stderr(): string;
	send(cmd: Record<string, unknown>): void;
	call(cmd: Record<string, unknown>): Promise<any>; // resolves with pi's response record
	quit(): Promise<void>;
}

let seq = 0;

export function startTerminalPi(opts: TerminalPiOptions): TerminalPi {
	const args = ["--mode", "rpc"];
	if (opts.loadBridge ?? true) args.push("-e", BRIDGE_ENTRY);
	if (opts.sessionFile) args.push("--session", opts.sessionFile);
	const proc = spawn(opts.piBin, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env, PI_WEB: "", PI_WEB_BRIDGE_SOCKET: opts.socketPath, ...opts.extraEnv } });
	const records = new Recorder<any>();
	let stderr = "";
	proc.stdout.setEncoding("utf8");
	proc.stdout.on(
		"data",
		lineSplitter((line) => {
			try {
				records.push(JSON.parse(line));
			} catch {}
		}),
	);
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (d: string) => (stderr += d));
	proc.stdin.on("error", () => {});
	const exited = new Promise<void>((resolve) => proc.on("close", () => resolve()));
	const write = (cmd: Record<string, unknown>) => proc.stdin.write(`${JSON.stringify(cmd)}\n`);
	return {
		proc,
		pid: proc.pid ?? -1,
		records,
		stderr: () => stderr,
		send: write,
		call(cmd) {
			const id = `term-${++seq}`;
			write({ ...cmd, id });
			return records.waitFor((r) => r.type === "response" && r.id === id, 30_000);
		},
		async quit() {
			proc.stdin.end();
			const timer = setTimeout(() => proc.kill("SIGTERM"), 5000);
			await exited;
			clearTimeout(timer);
		},
	};
}
```

- [ ] **Step 2: Write the failing extension tests**

`bridge/test/extension.test.ts`:

```ts
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fakeHub } from "../../hub/test/support/fake-hub.ts";
import { type FakeModel, HELLO, startFakeModel } from "../../hub/test/support/fake-model.ts";
import { makePiEnv } from "../../hub/test/support/pi-env.ts";
import { startTerminalPi } from "../../hub/test/support/terminal-pi.ts";

let model: FakeModel;
before(async () => {
	model = await startFakeModel();
});
after(() => model.close());

async function setup(t: TestContext, opts: { settings?: Record<string, unknown>; extraEnv?: Record<string, string>; noHub?: boolean } = {}) {
	model.setScript(HELLO);
	const env = makePiEnv({ modelUrl: model.url, settings: opts.settings });
	const sock = opts.noHub ? join(env.root, "missing", "bridge.sock") : join(env.root, "bridge.sock");
	const hub = opts.noHub ? null : await fakeHub(sock);
	const term = startTerminalPi({ piBin: env.piBin, cwd: env.workDir, env: env.env, socketPath: sock, extraEnv: opts.extraEnv });
	t.after(async () => {
		await term.quit();
		await hub?.close();
		env.cleanup();
	});
	return { env, hub, term };
}

const userText = (r: any) => (typeof r.message?.content === "string" ? r.message.content : JSON.stringify(r.message?.content ?? ""));

test("a terminal pi introduces itself with its session, models, levels and commands", async (t) => {
	const { hub, term } = await setup(t);
	const hello = await hub!.messages.waitFor((m) => m.type === "hello");
	const state = await term.call({ type: "get_state" });
	assert.equal(hello.sessionId, state.data.sessionId);
	assert.equal(hello.pid, term.pid);
	assert.match(hello.piVersion, /^\d+\.\d+\.\d+/);
	assert.deepEqual(hello.sync.models.map((m: { id: string }) => m.id).sort(), ["fake-a", "fake-b"]);
	assert.ok(hello.sync.thinkingLevels.includes("off") && hello.sync.thinkingLevels.includes("high"));
	assert.ok(hello.sync.commands.some((c: { name: string; source: string }) => c.name === "ask" && c.source === "extension"));
	assert.equal(hello.sync.state.model.id, "fake-a");
});

test("a prompt typed in the terminal streams to the hub in RPC shapes", async (t) => {
	const { hub, term } = await setup(t);
	await hub!.messages.next((m) => m.type === "hello");
	term.send({ type: "prompt", message: "from the terminal" });
	const ev = (type: string, pred: (e: any) => boolean = () => true) => hub!.messages.next((m) => m.type === "event" && m.event.type === type && pred(m.event));
	await ev("agent_start");
	assert.match(userText(await ev("message_end", (e) => e.message.role === "user")), /from the terminal/);
	const update = await ev("message_update");
	assert.equal("message" in update.event, false);
	assert.equal("partial" in update.event.assistantMessageEvent, false);
	assert.match(userText(await ev("message_end", (e) => e.message.role === "assistant")), /Hello world/);
	await ev("agent_settled");
	const sync = await hub!.messages.next((m) => m.type === "sync" && m.sync.state.isStreaming === false);
	assert.equal(sync.sync.stats.assistantMessages, 1);
});

test("the hub's commands take effect in the terminal pi", async (t) => {
	const { hub, term } = await setup(t);
	await hub!.messages.next((m) => m.type === "hello");
	const cmd = async (id: string, command: Record<string, unknown>) => {
		hub!.send({ type: "cmd", id, command });
		return hub!.messages.waitFor((m) => m.type === "result" && m.id === id);
	};
	assert.equal((await cmd("1", { type: "prompt", text: "from the app", mode: "send" })).ok, true);
	await term.records.waitFor((r) => r.type === "message_end" && r.message?.role === "user" && /from the app/.test(userText(r)));
	await term.records.waitFor((r) => r.type === "agent_settled");

	assert.equal((await cmd("2", { type: "set_model", provider: "fake", modelId: "fake-b" })).ok, true);
	await hub!.messages.waitFor((m) => m.type === "sync" && m.sync.state.model?.id === "fake-b");
	assert.equal((await term.call({ type: "get_state" })).data.model.id, "fake-b");

	assert.equal((await cmd("3", { type: "rename", name: "named from the app" })).ok, true);
	await hub!.messages.waitFor((m) => m.type === "sync" && m.sync.state.sessionName === "named from the app");

	const ask = await cmd("4", { type: "prompt", text: "/ask", mode: "send" });
	assert.equal(ask.ok, false);
	assert.match(ask.error, /extension command/);
	assert.ok(model.requests.every((r) => !JSON.stringify(r.messages).includes("/ask")));

	assert.match((await cmd("5", { type: "set_model", provider: "fake", modelId: "nope" })).error, /Model not found/);
});

test("a dialog open in the terminal is reported, and cleared once answered", async (t) => {
	const { hub, term } = await setup(t);
	await hub!.messages.next((m) => m.type === "hello");
	term.send({ type: "prompt", message: "/ask" });
	assert.deepEqual((await hub!.messages.next((m) => m.type === "prompt_state")).prompt, { kind: "select", title: "Pick one" });
	const req = await term.records.waitFor((r) => r.type === "extension_ui_request" && r.method === "select");
	term.send({ type: "extension_ui_response", id: req.id, value: "red" });
	assert.equal((await hub!.messages.next((m) => m.type === "prompt_state")).prompt, null);
});

test("hub notices reach the terminal UI", async (t) => {
	const { hub, term } = await setup(t);
	await hub!.messages.next((m) => m.type === "hello");
	hub!.send({ type: "notice", text: "hello from the hub" });
	await term.records.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && r.message === "hello from the hub");
});

test("compacting from the hub sends compaction events and a full sync", async (t) => {
	const { hub } = await setup(t, { settings: { compaction: { enabled: false, keepRecentTokens: 10 } } });
	await hub!.messages.next((m) => m.type === "hello");
	for (const [i, text] of ["one", "two", "three"].entries()) {
		hub!.send({ type: "cmd", id: `p${i}`, command: { type: "prompt", text, mode: "send" } });
		await hub!.messages.next((m) => m.type === "event" && m.event.type === "agent_settled");
	}
	hub!.send({ type: "cmd", id: "c", command: { type: "compact", instructions: "keep it short" } });
	await hub!.messages.waitFor((m) => m.type === "event" && m.event.type === "compaction_start");
	await hub!.messages.waitFor((m) => m.type === "event" && m.event.type === "compaction_end");
	assert.equal((await hub!.messages.waitFor((m) => m.type === "result" && m.id === "c", 30_000)).ok, true);
	const full = await hub!.messages.waitFor((m) => m.type === "sync" && Array.isArray(m.sync.messages));
	assert.equal(full.sync.messages[0].role, "compactionSummary");
});

test("a /new in the terminal says bye and introduces the new session", async (t) => {
	const { hub, term } = await setup(t);
	const first = await hub!.messages.next((m) => m.type === "hello");
	assert.equal((await term.call({ type: "new_session" })).success, true);
	assert.deepEqual(await hub!.messages.next((m) => m.type === "bye"), { type: "bye", reason: "new" });
	const second = await hub!.messages.next((m) => m.type === "hello");
	assert.notEqual(second.sessionId, first.sessionId);
	assert.equal(second.pid, first.pid);
});

test("the hub's own headless children (PI_WEB=1) never connect", async (t) => {
	const { hub, term } = await setup(t, { extraEnv: { PI_WEB: "1" } });
	assert.equal((await term.call({ type: "get_state" })).success, true);
	await sleep(1500);
	assert.equal(hub!.connections(), 0);
});

test("with no hub, pi starts and works normally and the bridge stays silent", async (t) => {
	const { term } = await setup(t, { noHub: true });
	assert.equal((await term.call({ type: "get_state" })).success, true);
	term.send({ type: "prompt", message: "hi" });
	await term.records.waitFor((r) => r.type === "agent_settled");
	assert.doesNotMatch(term.stderr(), /pi-web|bridge|ENOENT|ECONNREFUSED/i);
	assert.equal(term.records.items.filter((r) => r.type === "extension_error").length, 0);
});
```

Run: `npm test -w bridge`
Expected: FAIL, because `../index.ts` doesn't exist.

- [ ] **Step 3: Implement `bridge/index.ts`**

```ts
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
			buildMessages: (entries, leafId) => buildSessionContext(entries, leafId).messages as AgentMessage[],
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w bridge && npm run typecheck -w bridge`
Expected: PASS. If the `/new` test shows two `hello`s carrying the new session id, that is expected: `session_start` can fire twice. The `next` calls above already tolerate it, because they take the first match. The hub handles duplicates in Task 7.

- [ ] **Step 5: Commit**

```bash
git add bridge/index.ts bridge/test/extension.test.ts hub/test/support/terminal-pi.ts
git commit -m "feat(bridge): the pi extension, tested against real pi and a fake model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `BridgeHandle` in the hub

**Files:**
- Create: `hub/src/bridge-handle.ts`, `hub/test/bridge-handle.test.ts`
- Modify: `hub/src/handle.ts`

**Interfaces:**
- Consumes: the `shared/src/bridge.ts` types, `applyEvent` and `createConversation`, and `SessionHandle` and `HandleEvent`.
- Produces:
  - `SessionHandle.notice?(text: string): void`, a new optional member in `hub/src/handle.ts`.
  - `UNAVAILABLE_IN_TERMINAL = "Not available while open in the terminal."` in `hub/src/bridge-handle.ts`.
  - `BridgeConn { send(msg: HubToBridge): void; close(): void }`.
  - `class BridgeHandle implements SessionHandle`, with:
    - `constructor(conn: BridgeConn, hello: BridgeHello)`
    - `receive(msg: BridgeToHub): void` for `event`, `sync`, `prompt_state` and `result`
    - `detach(): void`, called when a runtime switch starts
    - `rebind(conn: BridgeConn, hello: BridgeHello): void`
    - `gone(): void`, called when the terminal pi has left
    - `notice(text: string): void`
    - `close()`, a no-op

- [ ] **Step 1: Add `notice` to the seam**

In `hub/src/handle.ts`, add the following member to `SessionHandle`, after `onEvent`:

```ts
	notice?(text: string): void; // bridge only: shown in the terminal TUI
```

Also update the header comment's last sentence to: `RpcHandle (headless child) and BridgeHandle (terminal pi) implement it.`

- [ ] **Step 2: Write the failing tests**

`hub/test/bridge-handle.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeHello, HubToBridge } from "../../shared/src/bridge.ts";
import type { AppCommand, StreamMessage } from "../../shared/src/protocol.ts";
import { BridgeHandle, UNAVAILABLE_IN_TERMINAL } from "../src/bridge-handle.ts";
import type { HandleEvent } from "../src/handle.ts";

const state = (id: string, extra = {}) => ({ model: null, thinkingLevel: "off" as const, isStreaming: false, isCompacting: false, sessionId: id, sessionFile: `/s/${id}.jsonl`, messageCount: 1, pendingMessageCount: 0, autoCompactionEnabled: true, ...extra });

function hello(id = "t-1", extra: Partial<BridgeHello> = {}): BridgeHello {
	return {
		type: "hello",
		protocol: 1,
		sessionId: id,
		sessionFile: `/s/${id}.jsonl`,
		cwd: "/work",
		pid: 777,
		piVersion: "1.0.2",
		prompt: null,
		sync: { state: state(id), stats: null, thinkingLevels: ["off"], models: [], commands: [{ name: "ask", source: "extension" }], messages: [{ role: "user", content: "earlier", timestamp: 1 }] },
		...extra,
	};
}

function setup(h0 = hello()) {
	const sent: HubToBridge[] = [];
	const conn = { send: (m: HubToBridge) => void sent.push(m), close: () => {} };
	const h = new BridgeHandle(conn, h0);
	const stream: StreamMessage[] = [];
	const events: HandleEvent[] = [];
	h.subscribe((m) => stream.push(m));
	h.onEvent((e) => events.push(e));
	return { h, sent, stream, events, conn };
}

test("the snapshot comes from hello: a terminal-owned session with its conversation", () => {
	const { h } = setup();
	const s = h.snapshot();
	assert.equal(s.handleKind, "bridge");
	assert.deepEqual(s.capabilities, { dialogs: "terminal", fork: false, clone: false, newSession: false, bash: false, export: false });
	assert.equal(s.conv.messages.length, 1);
	assert.equal(s.terminalPrompt, null);
	assert.deepEqual([h.sessionId, h.sessionFile, h.cwd, h.pid, h.kind], ["t-1", "/s/t-1.jsonl", "/work", 777, "bridge"]);
	assert.equal(h.liveState(), "idle");
});

test("events run through the reducer, reach subscribers, and move the live state", () => {
	const { h, stream, events } = setup();
	h.receive({ type: "event", event: { type: "agent_start" } });
	assert.equal(h.liveState(), "running");
	assert.equal(h.isBusy(), true);
	h.receive({ type: "event", event: { type: "message_end", message: { role: "user", content: "now" } } });
	h.receive({ type: "event", event: { type: "agent_settled" } });
	assert.equal(h.liveState(), "idle");
	assert.equal(h.snapshot().conv.messages.length, 2);
	assert.equal(stream.filter((m) => m.type === "event").length, 3);
	assert.equal(events.filter((e) => e.type === "state_changed").length, 2);
});

test("app commands the terminal can run are forwarded and answered by id", async () => {
	const { h, sent } = setup();
	const pending = h.command({ type: "prompt", text: "hi", mode: "send" });
	const cmd = sent.at(-1) as Extract<HubToBridge, { type: "cmd" }>;
	assert.deepEqual(cmd.command, { type: "prompt", text: "hi", mode: "send" });
	h.receive({ type: "result", id: cmd.id, ok: true });
	assert.deepEqual(await pending, { ok: true, data: undefined });
	const failing = h.command({ type: "rename", name: "x" });
	h.receive({ type: "result", id: (sent.at(-1) as { id: string }).id, ok: false, error: "nope" });
	assert.deepEqual(await failing, { ok: false, error: "nope" });
});

test("rpc-only commands are refused here, without bothering the terminal", async () => {
	const { h, sent } = setup();
	const table: Array<[AppCommand, string | null]> = [
		[{ type: "attach" }, null],
		[{ type: "fork", entryId: "e" }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "get_fork_points" }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "clone" }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "new_session" }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "bash", command: "ls", excludeFromContext: false }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "export" }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "clear_queue" }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "dialog_response", id: "d", cancelled: true }, "That dialog is open in the terminal."],
	];
	for (const [cmd, error] of table) assert.deepEqual(await h.command(cmd), error ? { ok: false, error } : { ok: true }, cmd.type);
	assert.equal(sent.length, 0);
});

test("a terminal dialog makes the session need you, and shows in meta and snapshots", () => {
	const { h, stream, events } = setup();
	h.receive({ type: "prompt_state", prompt: { kind: "confirm", title: "Allow rm?" } });
	assert.equal(h.liveState(), "needs_you");
	assert.deepEqual((stream.at(-1) as { terminalPrompt: unknown }).terminalPrompt, { kind: "confirm", title: "Allow rm?" });
	assert.deepEqual(h.snapshot().terminalPrompt, { kind: "confirm", title: "Allow rm?" });
	h.receive({ type: "prompt_state", prompt: null });
	assert.equal(h.liveState(), "idle");
	assert.equal(events.filter((e) => e.type === "state_changed").length, 2);
});

test("a state sync updates meta; a full sync replaces the conversation; a new name announces itself", () => {
	const { h, stream, events } = setup();
	h.receive({ type: "sync", sync: { state: state("t-1", { sessionName: "katsu" }), stats: null, thinkingLevels: ["off", "high"] } });
	assert.equal(stream.at(-1)?.type, "meta");
	assert.deepEqual(h.snapshot().thinkingLevels, ["off", "high"]);
	assert.ok(events.some((e) => e.type === "renamed"));
	h.receive({ type: "sync", sync: { state: state("t-1", { sessionName: "katsu" }), stats: null, thinkingLevels: ["off"], models: [], commands: [], messages: [{ role: "compactionSummary", summary: "s" }] } });
	assert.equal(stream.at(-1)?.type, "snapshot");
	assert.deepEqual(h.snapshot().conv.messages.map((m) => m.role), ["compactionSummary"]);
	assert.equal(events.filter((e) => e.type === "renamed").length, 1);
});

test("during a runtime switch commands wait for nothing and fail clearly; rebind re-keys and resnapshots", async () => {
	const { h, sent, stream, events } = setup();
	const inFlight = h.command({ type: "abort" });
	h.detach();
	assert.match((await inFlight).error ?? "", /switching sessions/);
	assert.match((await h.command({ type: "abort" })).error ?? "", /switching sessions/);
	const sent2: HubToBridge[] = [];
	h.rebind({ send: (m) => void sent2.push(m), close: () => {} }, hello("t-2"));
	assert.equal(h.sessionId, "t-2");
	assert.equal((stream.at(-1) as { snapshot: { sessionId: string } }).snapshot.sessionId, "t-2");
	assert.deepEqual(events.find((e) => e.type === "session_changed"), { type: "session_changed", from: "t-1", to: "t-2" });
	void h.command({ type: "abort" });
	assert.equal(sent2.length, 1);
	assert.equal(sent.length, 1);
});

test("gone: pending commands fail, subscribers get handle_gone, and the registry gets a clean exit", async () => {
	const { h, stream, events } = setup();
	const inFlight = h.command({ type: "abort" });
	h.gone();
	assert.equal((await inFlight).ok, false);
	assert.deepEqual(stream.at(-1), { type: "handle_gone", reason: "closed" });
	assert.deepEqual(events.at(-1), { type: "exit", code: 0, stderr: "", closedByHub: false });
	h.gone();
	assert.equal(events.filter((e) => e.type === "exit").length, 1);
});

test("notice goes to the terminal; close() leaves the terminal pi alone", () => {
	const { h, sent, stream } = setup();
	h.notice("hello");
	assert.deepEqual(sent, [{ type: "notice", text: "hello" }]);
	h.close();
	assert.equal(stream.some((m) => m.type === "handle_gone"), false);
});
```

Run: `npm test -w hub`
Expected: FAIL, because `../src/bridge-handle.ts` doesn't exist.

- [ ] **Step 3: Implement `hub/src/bridge-handle.ts`**

```ts
// A terminal `pi` with the bridge extension (spec §2.2). The bridge streams
// pi's events and state here and runs app commands over the socket. The hub
// never closes it: the person at the terminal owns that process.

import type { BridgeCommand, BridgeHello, BridgeSync, BridgeToHub, FullSync, HubToBridge } from "../../shared/src/bridge.ts";
import type {
	AppCommand,
	Capabilities,
	CommandInfo,
	CommandResult,
	Conversation,
	LiveState,
	ModelInfo,
	SessionStateInfo,
	SessionStats,
	Snapshot,
	StreamMessage,
	TerminalPrompt,
	ThinkingLevel,
} from "../../shared/src/protocol.ts";
import { applyEvent, createConversation } from "../../shared/src/reducer.ts";
import type { HandleEvent, SessionHandle } from "./handle.ts";

export const UNAVAILABLE_IN_TERMINAL = "Not available while open in the terminal.";
const COMMAND_TIMEOUT_MS = 30 * 60_000;

export interface BridgeConn {
	send(msg: HubToBridge): void;
	close(): void;
}

export class BridgeHandle implements SessionHandle {
	readonly kind = "bridge" as const;
	readonly capabilities: Capabilities = { dialogs: "terminal", fork: false, clone: false, newSession: false, bash: false, export: false };
	lastActive = Date.now();

	private conn: BridgeConn | null;
	private hello!: BridgeHello;
	private conv!: Conversation;
	private state!: SessionStateInfo;
	private stats: SessionStats | null = null;
	private models: ModelInfo[] = [];
	private commands: CommandInfo[] = [];
	private thinkingLevels: ThinkingLevel[] = [];
	private prompt: TerminalPrompt | null = null;
	private pending = new Map<string, (r: CommandResult) => void>();
	private subscribers = new Set<(m: StreamMessage) => void>();
	private listeners = new Set<(e: HandleEvent) => void>();
	private left = false;
	private seq = 0;

	constructor(conn: BridgeConn, hello: BridgeHello) {
		this.conn = conn;
		this.load(hello);
	}

	get sessionId(): string {
		return this.hello.sessionId;
	}
	get sessionFile(): string | null {
		return this.state.sessionFile ?? this.hello.sessionFile;
	}
	get cwd(): string {
		return this.hello.cwd;
	}
	get pid(): number {
		return this.hello.pid;
	}

	subscriberCount(): number {
		return this.subscribers.size;
	}
	isBusy(): boolean {
		return this.conv.streaming || this.conv.compacting || this.prompt !== null;
	}
	liveState(): LiveState {
		if (this.prompt) return "needs_you";
		return this.conv.streaming || this.conv.compacting ? "running" : "idle";
	}

	snapshot(): Snapshot {
		return {
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			cwd: this.cwd,
			handleKind: "bridge",
			capabilities: this.capabilities,
			conv: this.conv,
			state: this.state,
			stats: this.stats,
			models: this.models,
			thinkingLevels: this.thinkingLevels,
			commands: this.commands,
			dialogs: [],
			statuses: {},
			widgets: {},
			terminalPrompt: this.prompt,
		};
	}

	subscribe(fn: (m: StreamMessage) => void): () => void {
		this.subscribers.add(fn);
		return () => {
			this.subscribers.delete(fn);
		};
	}

	onEvent(fn: (e: HandleEvent) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	close(): void {} // spec §3.2: the hub only detaches from a terminal pi

	notice(text: string): void {
		this.conn?.send({ type: "notice", text });
	}

	async command(cmd: AppCommand): Promise<CommandResult> {
		this.lastActive = Date.now();
		switch (cmd.type) {
			case "attach":
				return { ok: true };
			case "prompt":
			case "abort":
			case "set_model":
			case "set_thinking":
			case "compact":
			case "rename":
				return this.forward(cmd);
			case "dialog_response":
				return { ok: false, error: "That dialog is open in the terminal." };
			default:
				return { ok: false, error: UNAVAILABLE_IN_TERMINAL };
		}
	}

	receive(msg: BridgeToHub): void {
		this.lastActive = Date.now();
		switch (msg.type) {
			case "event": {
				const before = this.liveState();
				applyEvent(this.conv, msg.event);
				this.broadcast({ type: "event", event: msg.event });
				if (this.liveState() !== before) this.emit({ type: "state_changed" });
				return;
			}
			case "sync":
				return this.applySync(msg.sync);
			case "prompt_state": {
				const before = this.liveState();
				this.prompt = msg.prompt;
				this.broadcast(this.meta());
				if (this.liveState() !== before) this.emit({ type: "state_changed" });
				return;
			}
			case "result": {
				const done = this.pending.get(msg.id);
				if (!done) return;
				this.pending.delete(msg.id);
				done(msg.ok ? { ok: true, data: msg.data } : { ok: false, error: msg.error ?? "Command failed" });
				return;
			}
		}
	}

	// The terminal pi is replacing its extension runtime (TUI /new, /resume, /fork, reload).
	detach(): void {
		this.conn = null;
		this.failPending("pi is switching sessions in the terminal. Try again in a moment.");
	}

	rebind(conn: BridgeConn, hello: BridgeHello): void {
		const from = this.sessionId;
		this.conn = conn;
		this.load(hello);
		this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
		if (hello.sessionId !== from) this.emit({ type: "session_changed", from, to: hello.sessionId });
		this.emit({ type: "state_changed" });
	}

	gone(): void {
		if (this.left) return;
		this.left = true;
		this.conn = null;
		this.failPending("pi is no longer open in the terminal.");
		this.broadcast({ type: "handle_gone", reason: "closed" });
		this.emit({ type: "exit", code: 0, stderr: "", closedByHub: false });
	}

	// ---- internals ----------------------------------------------------------

	private load(hello: BridgeHello): void {
		this.hello = hello;
		this.conv = createConversation(hello.sync.messages);
		this.conv.streaming = hello.sync.state.isStreaming;
		this.conv.compacting = hello.sync.state.isCompacting;
		this.prompt = hello.prompt;
		this.state = hello.sync.state;
		this.stats = hello.sync.stats;
		this.thinkingLevels = hello.sync.thinkingLevels;
		this.models = hello.sync.models;
		this.commands = hello.sync.commands;
	}

	private applySync(sync: BridgeSync | FullSync): void {
		const before = this.liveState();
		const prevName = this.state.sessionName;
		this.state = sync.state;
		this.stats = sync.stats;
		this.thinkingLevels = sync.thinkingLevels;
		if ("messages" in sync) {
			this.models = sync.models;
			this.commands = sync.commands;
			const streaming = this.conv.streaming;
			this.conv = createConversation(sync.messages);
			this.conv.streaming = streaming || sync.state.isStreaming;
			this.conv.compacting = sync.state.isCompacting;
			this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
		} else {
			this.broadcast(this.meta());
		}
		if (sync.state.sessionName !== prevName) this.emit({ type: "renamed" });
		if (this.liveState() !== before) this.emit({ type: "state_changed" });
	}

	private forward(command: BridgeCommand): Promise<CommandResult> {
		const conn = this.conn;
		if (!conn) return Promise.resolve({ ok: false, error: this.left ? "pi is no longer open in the terminal." : "pi is switching sessions in the terminal. Try again in a moment." });
		const id = String(++this.seq);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ ok: false, error: `${command.type} timed out` });
			}, COMMAND_TIMEOUT_MS);
			timer.unref();
			this.pending.set(id, (r) => {
				clearTimeout(timer);
				resolve(r);
			});
			conn.send({ type: "cmd", id, command });
		});
	}

	private failPending(error: string): void {
		const waiting = [...this.pending.values()];
		this.pending.clear();
		for (const done of waiting) done({ ok: false, error });
	}

	private meta(): StreamMessage {
		return { type: "meta", state: this.state, stats: this.stats, statuses: {}, widgets: {}, thinkingLevels: this.thinkingLevels, terminalPrompt: this.prompt };
	}

	private broadcast(m: StreamMessage): void {
		for (const fn of [...this.subscribers]) {
			try {
				fn(m);
			} catch (err) {
				console.error("pi-web: stream subscriber threw", err);
			}
		}
	}

	// Over a copy: registry listeners may (un)subscribe on this handle while handling an event.
	private emit(e: HandleEvent): void {
		for (const fn of [...this.listeners]) fn(e);
	}
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w hub && npm run typecheck -w hub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/bridge-handle.ts hub/src/handle.ts hub/test/bridge-handle.test.ts
git commit -m "feat(hub): BridgeHandle presents a terminal pi through the SessionHandle seam

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Collision rules in the registry, and streams that follow a takeover

**Files:**
- Modify: `hub/src/registry.ts`, `hub/src/server.ts:120-151`, `hub/test/support/fake-handle.ts`
- Test: `hub/test/registry.test.ts`, `hub/test/server.test.ts`

**Interfaces:**
- Consumes: `SessionHandle.notice?` (Task 5).
- Produces:
  - `Registry.attachBridge(h: SessionHandle): "attached" | "waiting" | "ignored"`.
  - Exported constants `BUSY_NOTICE` and `ELSEWHERE_NOTICE` from `hub/src/registry.ts`.
  - `FakeHandle`:
    - constructor `(sessionId, cwd?, sessionFile?, opts?: { kind?: HandleKind; pid?: number })`
    - `notices: string[]`
    - `deferGone: boolean`, plus `goneNow()` to push `handle_gone` later
    - `leave()`, which simulates a terminal pi quitting: `handle_gone` plus a clean exit
    - `fire()` now iterates over a copy

- [ ] **Step 1: Extend `FakeHandle`**

Replace `hub/test/support/fake-handle.ts` with this version. It keeps every existing behavior:

```ts
import type { AppCommand, Capabilities, CommandResult, HandleKind, LiveState, Snapshot, StreamMessage } from "../../../shared/src/protocol.ts";
import { createConversation } from "../../../shared/src/reducer.ts";
import type { HandleEvent, SessionHandle } from "../../src/handle.ts";

export class FakeHandle implements SessionHandle {
	readonly kind: HandleKind;
	readonly capabilities: Capabilities;
	readonly pid: number;
	readonly cwd: string;
	readonly sessionFile: string | null;
	sessionId: string;
	lastActive = 0;
	busy = false;
	state: LiveState = "idle";
	closed = false;
	/** When true, close() does not fire the exit event (simulates a child that has not exited yet). */
	deferExit = false;
	/** When true, close() does not push handle_gone either; call goneNow() (an RpcHandle's handle_gone waits for the child to exit). */
	deferGone = false;
	received: AppCommand[] = [];
	notices: string[] = [];
	conv = createConversation();
	private subs = new Set<(m: StreamMessage) => void>();
	private listeners = new Set<(e: HandleEvent) => void>();

	constructor(sessionId: string, cwd = "/tmp", sessionFile: string | null = null, opts: { kind?: HandleKind; pid?: number } = {}) {
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.sessionFile = sessionFile;
		this.kind = opts.kind ?? "rpc";
		this.pid = opts.pid ?? 4242;
		this.capabilities =
			this.kind === "rpc"
				? { dialogs: "here", fork: true, clone: true, newSession: true, bash: true, export: true }
				: { dialogs: "terminal", fork: false, clone: false, newSession: false, bash: false, export: false };
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
			handleKind: this.kind,
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
			terminalPrompt: null,
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
	notice(text: string): void {
		this.notices.push(text);
	}
	push(m: StreamMessage): void {
		for (const fn of [...this.subs]) fn(m);
	}
	fire(e: HandleEvent): void {
		for (const fn of [...this.listeners]) fn(e);
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (!this.deferGone) this.push({ type: "handle_gone", reason: "closed" });
		if (!this.deferExit && !this.deferGone) this.fireExit();
	}
	goneNow(): void {
		this.push({ type: "handle_gone", reason: "closed" });
		this.fireExit();
	}
	fireExit(): void {
		this.fire({ type: "exit", code: 0, stderr: "", closedByHub: true });
	}
	/** A terminal pi quitting. */
	leave(): void {
		this.push({ type: "handle_gone", reason: "closed" });
		this.fire({ type: "exit", code: 0, stderr: "", closedByHub: false });
	}
}
```

Run: `npm test -w hub`
Expected: PASS. Existing behavior is unchanged.

- [ ] **Step 2: Write the failing registry tests**

Append to `hub/test/registry.test.ts`. Also add `BUSY_NOTICE` and `ELSEWHERE_NOTICE` to the import from `../src/registry.ts`:

```ts
const bridge = (id: string, pid = 900) => new FakeHandle(id, "/w", `/s/${id}.jsonl`, { kind: "bridge", pid });

test("a terminal pi on a session nobody holds is attached as a bridge", async () => {
	const { registry, changes } = setup();
	const b = bridge("disk-1");
	assert.equal(registry.attachBridge(b), "attached");
	assert.equal(registry.get("disk-1"), b);
	assert.deepEqual(registry.info("disk-1"), { live: true, handleKind: "bridge", state: "idle" });
	assert.ok(changes.some((m) => m.type === "session_state" && m.sessionId === "disk-1" && m.handleKind === "bridge"));
});

test("an idle headless pi gives way to the terminal", async () => {
	const { registry, started } = setup();
	await registry.ensure("disk-1");
	const b = bridge("disk-1");
	assert.equal(registry.attachBridge(b), "attached");
	assert.equal(started[0].closed, true);
	assert.equal(registry.get("disk-1"), b);
	assert.deepEqual(b.notices, []);
});

test("a busy headless pi keeps the session; the terminal is told and takes over once it settles", async () => {
	const { registry, started } = setup();
	const rpc = (await registry.ensure("disk-1")) as FakeHandle;
	rpc.busy = true;
	const b = bridge("disk-1");
	assert.equal(registry.attachBridge(b), "waiting");
	assert.deepEqual(b.notices, [BUSY_NOTICE]);
	assert.equal(registry.get("disk-1"), rpc);
	rpc.state = "running";
	rpc.fire({ type: "state_changed" }); // still busy: nothing changes
	assert.equal(registry.get("disk-1"), rpc);
	rpc.busy = false;
	rpc.state = "idle";
	rpc.fire({ type: "state_changed" });
	assert.equal(started[0].closed, true);
	assert.equal(registry.get("disk-1"), b);
});

test("a second terminal on the same session waits until the first one leaves", async () => {
	const { registry } = setup();
	const first = bridge("disk-1", 901);
	const second = bridge("disk-1", 902);
	registry.attachBridge(first);
	assert.equal(registry.attachBridge(second), "waiting");
	assert.deepEqual(second.notices, [ELSEWHERE_NOTICE]);
	first.leave();
	assert.equal(registry.get("disk-1"), second);
});

test("a waiting terminal that quits is forgotten", async () => {
	const { registry } = setup();
	const first = bridge("disk-1", 901);
	const second = bridge("disk-1", 902);
	registry.attachBridge(first);
	registry.attachBridge(second);
	second.leave();
	first.leave();
	assert.equal(registry.get("disk-1"), undefined);
});

test("the hub's own headless child is never taken for a terminal", async () => {
	const { registry } = setup();
	const rpc = await registry.ensure("disk-1");
	assert.equal(registry.attachBridge(bridge("disk-2", rpc.pid)), "ignored");
	assert.equal(registry.get("disk-2"), undefined);
});

test("bridges are never reaped, evicted or closed, and don't count toward maxHeadless", async () => {
	const { registry, setClock } = setup({ maxHeadless: 1 });
	const b = bridge("disk-2");
	registry.attachBridge(b);
	await registry.ensure("disk-1"); // the one headless slot
	setClock(1_000_000);
	registry.reap();
	registry.close("disk-2");
	registry.closeAll();
	assert.equal(b.closed, false);
	assert.equal(registry.get("disk-2"), b);
});

test("a terminal that switches onto a session an idle headless pi holds takes it over", async () => {
	const { registry, started } = setup();
	const b = bridge("disk-2");
	registry.attachBridge(b);
	await registry.ensure("disk-1");
	b.sessionId = "disk-1";
	b.fire({ type: "session_changed", from: "disk-2", to: "disk-1" });
	assert.equal(started[0].closed, true);
	assert.equal(registry.get("disk-1"), b);
	assert.equal(registry.get("disk-2"), undefined);
});
```

Run: `npm test -w hub`
Expected: FAIL, because `attachBridge` is not a function.

- [ ] **Step 3: Implement the collision rules in `hub/src/registry.ts`**

Change the header comment to:

```ts
// Which pi process (if any) is serving each session. Starts headless pi on
// demand, follows sessions that move (fork/clone/new), keeps at most
// maxHeadless running, closes idle ones, and decides between a headless pi
// and a terminal pi that want the same session (spec §3.2).
```

Add the exported notices after the imports:

```ts
export const BUSY_NOTICE = "This session is running in pi-web. Wait for it to finish, or /quit.";
export const ELSEWHERE_NOTICE = "This session is open in another terminal; pi-web follows that one.";
```

Add the field `private waiting = new Map<SessionHandle, () => void>(); // terminals waiting for a session another handle holds`. Then add these public and private methods to `Registry`:

```ts
	// A terminal pi announced itself over the bridge socket.
	attachBridge(h: SessionHandle): "attached" | "waiting" | "ignored" {
		if (this.all().some((x) => x.kind === "rpc" && x.pid === h.pid)) return "ignored"; // our own headless child
		return this.claim(h);
	}

	private claim(h: SessionHandle): "attached" | "waiting" {
		const holder = this.handles.get(h.sessionId);
		if (holder && holder !== h) {
			if (holder.kind !== "rpc" || holder.isBusy()) {
				this.wait(h);
				h.notice?.(holder.kind === "rpc" ? BUSY_NOTICE : ELSEWHERE_NOTICE);
				return "waiting";
			}
			this.forget(holder, false);
			holder.close();
		}
		this.adopt(h);
		return "attached";
	}

	private wait(h: SessionHandle): void {
		const off = h.onEvent((e) => {
			if (e.type !== "exit" && e.type !== "session_changed") return;
			off();
			this.waiting.delete(h);
			if (e.type === "session_changed") this.claim(h);
		});
		this.waiting.set(h, off);
	}

	private hasWaiter(id: string): boolean {
		return [...this.waiting.keys()].some((h) => h.sessionId === id);
	}

	// The session is free: the longest-waiting terminal for it takes over.
	private promote(id: string): void {
		const next = [...this.waiting.keys()].find((h) => h.sessionId === id);
		if (!next) return;
		this.waiting.get(next)?.();
		this.waiting.delete(next);
		this.claim(next);
	}
```

In `adopt`, replace the `state_changed` and `session_changed` cases with:

```ts
				case "state_changed":
					this.emitState(h.sessionId);
					if (h.kind === "rpc" && !h.isBusy() && this.hasWaiter(h.sessionId)) {
						this.forget(h);
						h.close();
					}
					break;
				case "renamed":
					this.emit({ type: "session_list_changed" });
					break;
				case "session_changed": {
					const holder = this.handles.get(e.to);
					if (holder && holder !== h) {
						// A terminal moved onto a session someone else holds.
						this.forget(h);
						this.claim(h);
						break;
					}
					if (this.handles.get(e.from) === h) this.handles.delete(e.from);
					this.handles.set(e.to, h);
					this.emitState(e.from);
					this.emitState(e.to);
					this.emit({ type: "session_list_changed" });
					this.promote(e.from);
					break;
				}
```

(The `renamed` case is unchanged; it's shown so the edit is unambiguous. The `exit` case stays as it is.)

Replace `forget` with:

```ts
	private forget(h: SessionHandle, promote = true): void {
		this.unsubscribers.get(h)?.();
		this.unsubscribers.delete(h);
		const freed: string[] = [];
		for (const [id, x] of [...this.handles]) {
			if (x !== h) continue;
			this.handles.delete(id);
			this.emitState(id);
			freed.push(id);
		}
		if (promote) for (const id of freed) this.promote(id);
	}
```

`close`, `closeAll`, `reap` and `makeRoom` already filter on `kind === "rpc"`, so they need no change.

- [ ] **Step 4: Run the registry tests**

Run: `npm test -w hub`
Expected: the registry tests PASS.

- [ ] **Step 5: Write the failing server test**

A headless pi's `handle_gone` arrives only once its child exits, which is after the registry adopted the terminal. In `hub/test/server.test.ts`, add this test after "a stream follows session_changed and re-attaches under the new id":

```ts
test("a stream moves to the terminal when it takes over a session the app had open", async () => {
	await call(port, "POST", "/api/sessions/disk-1/commands", GOOD, { type: "attach" });
	const rpc = handles.get("disk-1") as FakeHandle;
	rpc.deferGone = true; // like RpcHandle: handle_gone comes when the child exits, later
	const sse = await openSse(port, "/api/sessions/disk-1/stream", GOOD);
	assert.equal(((await sse.next((m) => m.type === "snapshot")).snapshot as { handleKind: string }).handleKind, "rpc");
	const term = new FakeHandle("disk-1", work, null, { kind: "bridge", pid: 31337 });
	assert.equal(registry.attachBridge(term), "attached");
	rpc.goneNow();
	await sse.next((m) => m.type === "detached");
	assert.equal(((await sse.next((m) => m.type === "snapshot")).snapshot as { handleKind: string }).handleKind, "bridge");
	term.leave();
	await sse.next((m) => m.type === "detached");
	sse.close();
});
```

Run: `npm test -w hub`
Expected: FAIL. It times out waiting for the second snapshot.

- [ ] **Step 6: Re-attach after `handle_gone` in `hub/src/server.ts`**

In `sessionStream`, replace the `attach` function with:

```ts
	const attach = (h: SessionHandle) => {
		detach?.();
		const unsubscribe = h.subscribe((msg) => {
			if (msg.type === "snapshot") id = msg.snapshot.sessionId; // follows fork/clone/new
			sse.send(msg);
			if (msg.type === "handle_gone") {
				unsubscribe();
				detach = null;
				sse.send({ type: "detached" });
				// Another handle may already hold the session (a terminal took over before this one exited).
				const next = registry.get(id);
				if (next && next !== h) attach(next);
			}
		});
		detach = unsubscribe;
		sse.send({ type: "snapshot", snapshot: h.snapshot() });
	};
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npm test -w hub && npm run typecheck -w hub`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add hub/src/registry.ts hub/src/server.ts hub/test/support/fake-handle.ts hub/test/registry.test.ts hub/test/server.test.ts
git commit -m "feat(hub): collision rules between headless and terminal pi; streams follow a takeover

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The bridge socket server, wired into the hub

**Files:**
- Create: `hub/src/bridge-server.ts`, `hub/test/bridge-server.test.ts`
- Modify: `hub/src/main.ts`

**Interfaces:**
- Consumes: `BridgeHandle` (Task 5), `Registry.attachBridge` (Task 6), `lineSplitter`, and the `shared/src/bridge.ts` types.
- Produces:
  - `startBridgeServer(opts: BridgeServerOptions): Promise<BridgeServer>`. The options are `{ socketPath: string; registry: { attachBridge(h: BridgeHandle): "attached" | "waiting" | "ignored" }; switchGraceMs?: number (5000); helloTimeoutMs?: number (5000); log?: (m: string) => void }`.
  - `BridgeServer` is `{ close(): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

`hub/test/bridge-server.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Socket, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { BridgeHello } from "../../shared/src/bridge.ts";
import { lineSplitter } from "../../shared/src/jsonl.ts";
import type { StreamMessage } from "../../shared/src/protocol.ts";
import type { BridgeHandle } from "../src/bridge-handle.ts";
import { startBridgeServer } from "../src/bridge-server.ts";
import type { HandleEvent } from "../src/handle.ts";
import { Recorder } from "./support/recorder.ts";

const state = (id: string) => ({ model: null, thinkingLevel: "off" as const, isStreaming: false, isCompacting: false, sessionId: id, messageCount: 0, pendingMessageCount: 0, autoCompactionEnabled: true });
const hello = (id: string, pid = 500, protocol = 1): BridgeHello => ({
	type: "hello",
	protocol,
	sessionId: id,
	sessionFile: null,
	cwd: "/w",
	pid,
	piVersion: "1.0.2",
	prompt: null,
	sync: { state: state(id), stats: null, thinkingLevels: ["off"], models: [], commands: [], messages: [] },
});

async function setup(t: TestContext, verdict: "attached" | "waiting" | "ignored" = "attached") {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-bsrv-"));
	const socketPath = join(dir, "data", "bridge.sock");
	const attached: BridgeHandle[] = [];
	const server = await startBridgeServer({ socketPath, switchGraceMs: 150, helloTimeoutMs: 150, registry: { attachBridge: (h) => (attached.push(h), verdict) } });
	t.after(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { dir, socketPath, attached, server };
}

async function client(path: string) {
	const sock: Socket = createConnection(path);
	const got = new Recorder<any>();
	const closed = new Promise<void>((r) => sock.on("close", () => r()));
	sock.setEncoding("utf8");
	sock.on("data", lineSplitter((l) => got.push(JSON.parse(l))));
	sock.on("error", () => {});
	await new Promise<void>((r) => sock.on("connect", () => r()));
	return { sock, got, closed, send: (m: unknown) => sock.write(`${JSON.stringify(m)}\n`) };
}

function watch(h: BridgeHandle) {
	const stream = new Recorder<StreamMessage>();
	const events = new Recorder<HandleEvent>();
	h.subscribe((m) => stream.push(m));
	h.onEvent((e) => events.push(e));
	return { stream, events };
}

const until = async (cond: () => boolean) => {
	for (let i = 0; i < 200 && !cond(); i++) await sleep(5);
	assert.ok(cond(), "condition never became true");
};

test("the socket is private: 0600 inside a 0700 directory", async (t) => {
	const { socketPath } = await setup(t);
	assert.equal(statSync(socketPath).mode & 0o777, 0o600);
	assert.equal(statSync(join(socketPath, "..")).mode & 0o777, 0o700);
});

test("a stale socket file is replaced; a live hub on the socket is refused", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-bsrv-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const socketPath = join(dir, "bridge.sock");
	writeFileSync(socketPath, "left over by a crashed hub");
	const registry = { attachBridge: () => "attached" as const };
	const first = await startBridgeServer({ socketPath, registry });
	await assert.rejects(startBridgeServer({ socketPath, registry }), /Another pi-web hub/);
	await first.close();
});

test("hello attaches a BridgeHandle; events, commands and results flow both ways", async (t) => {
	const { socketPath, attached } = await setup(t);
	const c = await client(socketPath);
	c.send(hello("s-1"));
	await until(() => attached.length === 1);
	const h = attached[0];
	assert.deepEqual([h.sessionId, h.pid], ["s-1", 500]);
	const { stream } = watch(h);
	c.send({ type: "event", event: { type: "agent_start" } });
	await stream.next((m) => m.type === "event");
	const result = h.command({ type: "abort" });
	const cmd = await c.got.next((m) => m.type === "cmd");
	assert.deepEqual(cmd.command, { type: "abort" });
	c.send({ type: "result", id: cmd.id, ok: true });
	assert.equal((await result).ok, true);
	c.sock.destroy();
});

test("a connection that never says hello is dropped; a newer protocol is told to update", async (t) => {
	const { socketPath, attached } = await setup(t);
	const silent = await client(socketPath);
	await silent.closed;
	const future = await client(socketPath);
	future.send(hello("s-1", 500, 99));
	assert.match((await future.got.next((m) => m.type === "notice")).text, /protocol/);
	await future.closed;
	assert.equal(attached.length, 0);
});

test("bye(new) then hello on a new connection: the same handle follows the terminal to its new session", async (t) => {
	const { socketPath, attached } = await setup(t);
	const a = await client(socketPath);
	a.send(hello("s-1"));
	await until(() => attached.length === 1);
	const h = attached[0];
	const { stream, events } = watch(h);
	a.send({ type: "bye", reason: "new" });
	a.sock.end();
	const b = await client(socketPath);
	b.send(hello("s-2"));
	assert.deepEqual(await events.next((e) => e.type === "session_changed"), { type: "session_changed", from: "s-1", to: "s-2" });
	assert.equal(attached.length, 1);
	assert.equal(h.sessionId, "s-2");
	await sleep(250); // past the grace period
	assert.equal(stream.items.some((m) => m.type === "handle_gone"), false);
	b.sock.destroy();
});

test("the new runtime's hello can arrive before the old runtime's bye", async (t) => {
	const { socketPath, attached } = await setup(t);
	const a = await client(socketPath);
	a.send(hello("s-1"));
	await until(() => attached.length === 1);
	const { stream } = watch(attached[0]);
	const b = await client(socketPath);
	b.send(hello("s-2"));
	await stream.next((m) => m.type === "snapshot");
	a.send({ type: "bye", reason: "new" }); // late, from the replaced runtime: ignored
	a.send({ type: "event", event: { type: "agent_start" } });
	await sleep(250);
	assert.equal(attached[0].liveState(), "idle");
	assert.equal(stream.items.some((m) => m.type === "handle_gone"), false);
	b.send({ type: "event", event: { type: "agent_start" } });
	await stream.next((m) => m.type === "event");
	assert.equal(attached.length, 1);
	b.sock.destroy();
});

test("a switch that never completes ends the handle after the grace period", async (t) => {
	const { socketPath, attached } = await setup(t);
	const a = await client(socketPath);
	a.send(hello("s-1"));
	await until(() => attached.length === 1);
	const { stream } = watch(attached[0]);
	a.send({ type: "bye", reason: "resume" });
	a.sock.end();
	await stream.next((m) => m.type === "handle_gone");
});

test("quitting, or dropping the connection, ends the handle at once", async (t) => {
	const { socketPath, attached } = await setup(t);
	const a = await client(socketPath);
	a.send(hello("s-1", 1));
	const b = await client(socketPath);
	b.send(hello("s-2", 2));
	await until(() => attached.length === 2);
	const wa = watch(attached.find((h) => h.pid === 1) as BridgeHandle);
	const wb = watch(attached.find((h) => h.pid === 2) as BridgeHandle);
	a.send({ type: "bye", reason: "quit" });
	await wa.stream.next((m) => m.type === "handle_gone");
	b.sock.destroy();
	await wb.stream.next((m) => m.type === "handle_gone");
});

test("a connection the registry ignores is left alone", async (t) => {
	const { socketPath, attached } = await setup(t, "ignored");
	const a = await client(socketPath);
	a.send(hello("s-1"));
	await until(() => attached.length === 1);
	const { stream } = watch(attached[0]);
	a.send({ type: "event", event: { type: "agent_start" } });
	await sleep(100);
	assert.equal(stream.items.length, 0);
	a.sock.destroy();
});
```

Run: `npm test -w hub`
Expected: FAIL, because `../src/bridge-server.ts` doesn't exist.

- [ ] **Step 2: Implement `hub/src/bridge-server.ts`**

```ts
// The hub's end of the bridge (spec §2.3): a private Unix socket terminal pi
// processes connect to. There is one connection per pi extension runtime. A TUI
// /new, /resume or /fork replaces the runtime, so the same pid says bye on one
// connection and hello on the next, in either order; the pid's BridgeHandle
// survives the switch for a grace period and follows it.

import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { type Socket, createConnection, createServer } from "node:net";
import { dirname } from "node:path";
import { BRIDGE_PROTOCOL, type BridgeHello, type BridgeToHub, type ByeReason, type HubToBridge } from "../../shared/src/bridge.ts";
import { lineSplitter } from "../../shared/src/jsonl.ts";
import { type BridgeConn, BridgeHandle } from "./bridge-handle.ts";

export interface BridgeServerOptions {
	socketPath: string;
	registry: { attachBridge(h: BridgeHandle): "attached" | "waiting" | "ignored" };
	switchGraceMs?: number;
	helloTimeoutMs?: number;
	log?: (msg: string) => void;
}

export interface BridgeServer {
	close(): Promise<void>;
}

interface Entry {
	handle: BridgeHandle;
	sock: Socket | null; // the connection of the pid's current runtime
	grace: NodeJS.Timeout | null; // running while a runtime switch is under way
}

export async function startBridgeServer(opts: BridgeServerOptions): Promise<BridgeServer> {
	const log = opts.log ?? (() => {});
	const graceMs = opts.switchGraceMs ?? 5000;
	const dir = dirname(opts.socketPath);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	if (existsSync(opts.socketPath)) {
		if (await answers(opts.socketPath)) throw new Error(`Another pi-web hub is listening on ${opts.socketPath}`);
		unlinkSync(opts.socketPath); // left by a hub that crashed
	}

	const byPid = new Map<number, Entry>();
	const sockets = new Set<Socket>();

	const end = (pid: number, e: Entry) => {
		if (e.grace) clearTimeout(e.grace);
		if (byPid.get(pid) === e) byPid.delete(pid);
		log(`terminal pi ${pid} left ${e.handle.sessionId}`);
		e.handle.gone();
	};

	const onBye = (pid: number, e: Entry, reason: ByeReason) => {
		if (reason === "quit") return end(pid, e);
		e.handle.detach();
		if (e.grace) clearTimeout(e.grace);
		e.grace = setTimeout(() => end(pid, e), graceMs);
		e.grace.unref();
	};

	const server = createServer((sock) => {
		sockets.add(sock);
		sock.setEncoding("utf8");
		sock.on("error", () => {});
		let pid: number | null = null;
		let ignored = false;
		const helloTimer = setTimeout(() => sock.destroy(), opts.helloTimeoutMs ?? 5000);
		const conn: BridgeConn = { send: (m) => write(sock, m), close: () => sock.destroy() };

		const onHello = (hello: BridgeHello) => {
			clearTimeout(helloTimer);
			if (hello.protocol !== BRIDGE_PROTOCOL) {
				write(sock, { type: "notice", text: `pi-web: this bridge speaks protocol ${hello.protocol} but the hub speaks ${BRIDGE_PROTOCOL}. Update pi-web.` });
				sock.end();
				return;
			}
			pid = hello.pid;
			const e = byPid.get(pid);
			if (e) {
				// The same pi process with a new runtime (or a duplicate session_start).
				if (e.grace) clearTimeout(e.grace);
				e.grace = null;
				const old = e.sock;
				e.sock = sock;
				if (old && old !== sock) old.destroy();
				e.handle.rebind(conn, hello);
				return;
			}
			const handle = new BridgeHandle(conn, hello);
			if (opts.registry.attachBridge(handle) === "ignored") {
				ignored = true;
				return;
			}
			byPid.set(pid, { handle, sock, grace: null });
			log(`terminal pi ${pid} attached ${hello.sessionId}`);
		};

		sock.on(
			"data",
			lineSplitter((line) => {
				let msg: BridgeToHub;
				try {
					msg = JSON.parse(line);
				} catch {
					return;
				}
				if (msg.type === "hello") return onHello(msg);
				if (ignored || pid === null) return;
				const e = byPid.get(pid);
				if (!e || e.sock !== sock) return; // late messages from a replaced runtime
				if (msg.type === "bye") return onBye(pid, e, msg.reason);
				e.handle.receive(msg);
			}),
		);

		sock.on("close", () => {
			clearTimeout(helloTimer);
			sockets.delete(sock);
			if (pid === null) return;
			const e = byPid.get(pid);
			if (!e || e.sock !== sock) return;
			e.sock = null;
			if (!e.grace) end(pid, e); // gone without a session switch under way
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	chmodSync(opts.socketPath, 0o600);

	return {
		async close() {
			for (const [pid, e] of [...byPid]) end(pid, e);
			for (const s of sockets) s.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
		},
	};
}

function write(sock: Socket, msg: HubToBridge): void {
	if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`);
}

function answers(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createConnection(path);
		s.once("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.once("error", () => resolve(false));
	});
}
```

- [ ] **Step 3: Run the tests**

Run: `npm test -w hub`
Expected: PASS.

- [ ] **Step 4: Start the bridge server in `hub/src/main.ts`**

Add `import { startBridgeServer } from "./bridge-server.ts";`. After `setInterval(() => registry.reap(), 60_000).unref();`, add:

```ts
let bridge: Awaited<ReturnType<typeof startBridgeServer>>;
try {
	bridge = await startBridgeServer({ socketPath: join(cfg.dataDir, "bridge.sock"), registry, log: (m) => console.log(m) });
} catch (err) {
	console.error((err as Error).message);
	process.exit(1);
}
```

In the `listen` log line, add the socket after the sessions directory: `` (serving https://${cfg.hostname}, sessions in ${index.dir}, terminals on ${join(cfg.dataDir, "bridge.sock")}) ``. In `shutdown`, call `void bridge.close();` right after `registry.closeAll();`.

- [ ] **Step 5: Smoke-test the real hub boot**

Run:

```bash
D=$(mktemp -d) && printf '{"hostname":"localhost:7899","allowedLogin":"dev@local","port":7899}' > $D/config.json && (PI_WEB_DATA_DIR=$D timeout 3 node hub/src/main.ts; true) && ls -l $D
```

Expected: the log line mentions `terminals on …/bridge.sock`. After the timeout, the listing shows `config.json` and `exports`, and no leftover `bridge.sock`; if the process was killed before cleanup, the next start replaces it.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck -w hub && npm test -w hub`
Expected: PASS.

```bash
git add hub/src/bridge-server.ts hub/src/main.ts hub/test/bridge-server.test.ts
git commit -m "feat(hub): bridge socket server; a terminal pi's handle survives TUI session switches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Hub and bridge together, against real pi

**Files:**
- Create: `hub/test/bridge.test.ts`

**Interfaces:**
- Consumes:
  - `startBridgeServer` (Task 7) and `Registry` (Task 6)
  - `RpcHandle.start` and `SessionIndex` (Plan 1)
  - `startTerminalPi` and `BRIDGE_ENTRY` (Task 4)
  - `makePiEnv` and `startFakeModel` (Plan 1)
- Produces: nothing new. This is the end-to-end proof of spec §8, "BridgeHandle integration".

- [ ] **Step 1: Write the integration tests**

`hub/test/bridge.test.ts`:

```ts
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ListMessage, StreamMessage } from "../../shared/src/protocol.ts";
import { startBridgeServer } from "../src/bridge-server.ts";
import type { SessionHandle } from "../src/handle.ts";
import { Registry } from "../src/registry.ts";
import { RpcHandle } from "../src/rpc-handle.ts";
import { SessionIndex } from "../src/sessions.ts";
import { type FakeModel, HELLO, startFakeModel } from "./support/fake-model.ts";
import { makePiEnv } from "./support/pi-env.ts";
import { Recorder } from "./support/recorder.ts";
import { BRIDGE_ENTRY, startTerminalPi } from "./support/terminal-pi.ts";

let model: FakeModel;
before(async () => {
	model = await startFakeModel();
});
after(() => model.close());

// A hub with the bridge loaded for every pi in this config, the hub's own children included.
async function setup(t: TestContext) {
	model.setScript(HELLO);
	const env = makePiEnv({ modelUrl: model.url, settings: { extensions: [BRIDGE_ENTRY] } });
	const socketPath = join(env.root, "hub", "bridge.sock");
	const index = new SessionIndex(join(env.agentDir, "sessions"));
	const registry = new Registry({
		factory: { startRpc: (o) => RpcHandle.start({ ...o, piBin: env.piBin, exportDir: join(env.root, "exports"), env: env.env }) },
		lookup: index,
		maxHeadless: 6,
		idleMs: 60_000,
	});
	const list = new Recorder<ListMessage>();
	registry.onChange((m) => list.push(m));
	const bridge = await startBridgeServer({ socketPath, registry, switchGraceMs: 3000 });
	const terminals: ReturnType<typeof startTerminalPi>[] = [];
	const terminal = (sessionFile?: string) => {
		const term = startTerminalPi({ piBin: env.piBin, cwd: env.workDir, env: env.env, socketPath, sessionFile, loadBridge: false });
		terminals.push(term);
		return term;
	};
	t.after(async () => {
		await Promise.all(terminals.map((x) => x.quit()));
		registry.closeAll();
		await bridge.close();
		await sleep(300);
		env.cleanup();
	});
	return { env, registry, list, terminal };
}

const until = async (cond: () => boolean, timeoutMs = 15_000) => {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error("condition never became true");
		await sleep(20);
	}
};

const bridgeFor = (registry: Registry, pid: number) => registry.all().find((h) => h.kind === "bridge" && h.pid === pid);

function watch(h: SessionHandle) {
	const r = new Recorder<StreamMessage>();
	h.subscribe((m) => r.push(m));
	return r;
}

const text = (m: any) => JSON.stringify(m?.content ?? "");

test("a terminal pi is live in the hub; prompts from the app and the terminal both stream", async (t) => {
	const { registry, terminal } = await setup(t);
	const term = terminal();
	await until(() => Boolean(bridgeFor(registry, term.pid)));
	const h = bridgeFor(registry, term.pid) as SessionHandle;
	assert.deepEqual(registry.info(h.sessionId), { live: true, handleKind: "bridge", state: "idle" });
	const stream = watch(h);

	assert.equal((await h.command({ type: "prompt", text: "from the app", mode: "send" })).ok, true);
	await stream.next((m) => m.type === "event" && m.event.type === "message_end" && m.event.message.role === "assistant");
	await stream.next((m) => m.type === "event" && m.event.type === "agent_settled");
	await term.records.waitFor((r) => r.type === "message_end" && r.message?.role === "user" && /from the app/.test(text(r.message)));

	term.send({ type: "prompt", message: "from the terminal" });
	await stream.next((m) => m.type === "event" && m.event.type === "message_end" && m.event.message.role === "user" && /from the terminal/.test(text(m.event.message)));
	await stream.next((m) => m.type === "event" && m.event.type === "agent_settled");
	assert.deepEqual(
		h.snapshot().conv.messages.map((m) => m.role),
		["user", "assistant", "user", "assistant"],
	);
});

test("model and name changes from the app come back as state; a terminal dialog is needs_you", async (t) => {
	const { registry, list, terminal } = await setup(t);
	const term = terminal();
	await until(() => Boolean(bridgeFor(registry, term.pid)));
	const h = bridgeFor(registry, term.pid) as SessionHandle;
	assert.equal((await h.command({ type: "set_model", provider: "fake", modelId: "fake-b" })).ok, true);
	await until(() => h.snapshot().state.model?.id === "fake-b");
	assert.equal((await h.command({ type: "rename", name: "from the app" })).ok, true);
	await until(() => h.snapshot().state.sessionName === "from the app");
	await list.waitFor((m) => m.type === "session_list_changed");

	term.send({ type: "prompt", message: "/ask" });
	await until(() => h.liveState() === "needs_you");
	assert.equal(h.snapshot().terminalPrompt?.title, "Pick one");
	const req = await term.records.waitFor((r) => r.type === "extension_ui_request" && r.method === "select");
	term.send({ type: "extension_ui_response", id: req.id, value: "red" });
	await until(() => h.liveState() === "idle");
	assert.match((await h.command({ type: "prompt", text: "/ask", mode: "send" })).error ?? "", /extension command/);
});

test("the hub's own headless children load the bridge but never attach as terminals", async (t) => {
	const { env, registry } = await setup(t);
	const rpc = await registry.create(env.workDir);
	await sleep(1500);
	assert.equal(registry.get(rpc.sessionId)?.kind, "rpc");
	assert.equal(registry.all().filter((h) => h.kind === "bridge").length, 0);
});

test("a terminal resuming a session the app holds idle takes it over; a busy one makes it wait", async (t) => {
	const { env, registry, terminal } = await setup(t);
	// A session with a file on disk, held by a headless pi.
	const rpc = await registry.create(env.workDir);
	const id = rpc.sessionId;
	const done = watch(rpc);
	await rpc.command({ type: "prompt", text: "first", mode: "send" });
	await done.next((m) => m.type === "event" && m.event.type === "agent_settled");
	const file = rpc.sessionFile as string;

	// Busy: the headless pi is mid-reply when the terminal opens the same file.
	model.setScript(() => ({ text: "a slow reply in many small pieces", chunkDelayMs: 150 }));
	await rpc.command({ type: "prompt", text: "second", mode: "send" });
	await until(() => rpc.isBusy());
	const term = terminal(file);
	await term.records.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && /running in pi-web/.test(r.message));
	assert.equal(registry.get(id), rpc);

	// Once it settles, the terminal takes over and the headless pi is closed.
	await until(() => registry.get(id)?.kind === "bridge", 30_000);
	assert.equal(registry.get(id)?.pid, term.pid);
	assert.equal(registry.all().filter((h) => h.kind === "rpc").length, 0);
});

test("a /new in the terminal moves the app's stream to the new session", async (t) => {
	const { registry, terminal } = await setup(t);
	const term = terminal();
	await until(() => Boolean(bridgeFor(registry, term.pid)));
	const h = bridgeFor(registry, term.pid) as SessionHandle;
	const from = h.sessionId;
	const stream = watch(h);
	assert.equal((await term.call({ type: "new_session" })).success, true);
	const snap = await stream.next((m) => m.type === "snapshot");
	const to = (snap as Extract<StreamMessage, { type: "snapshot" }>).snapshot.sessionId;
	assert.notEqual(to, from);
	assert.equal(registry.get(to), h);
	assert.equal(registry.get(from), undefined);
	await sleep(500);
	assert.equal(stream.items.some((m) => m.type === "handle_gone"), false);
	assert.equal(registry.all().filter((x) => x.kind === "bridge").length, 1);
});

test("quitting the terminal ends the session's live state", async (t) => {
	const { registry, terminal } = await setup(t);
	const term = terminal();
	await until(() => Boolean(bridgeFor(registry, term.pid)));
	const h = bridgeFor(registry, term.pid) as SessionHandle;
	const stream = watch(h);
	await term.quit();
	await stream.next((m) => m.type === "handle_gone");
	assert.deepEqual(registry.info(h.sessionId), { live: false, handleKind: null, state: "idle" });
});
```

- [ ] **Step 2: Run them**

Run: `npm test -w hub`
Expected: PASS.

If a test fails, debug with superpowers:systematic-debugging before changing any code. These are the likeliest causes, with the earlier task that owns each fix:
- `model_select` fires before `ctx.model` reflects the new model. The sync would then carry the old model. Fix in Task 3: on `model_select`, put `slimModel(ev.model)` into the sync's state.
- `session_start` fires twice on `/new`. The Task 7 rebind path covers it. Confirm with the assertion of exactly one bridge.
- The headless pi writes to the session file while the terminal opens it. The test only reads registry state, so this is benign.

- [ ] **Step 3: Commit**

```bash
git add hub/test/bridge.test.ts
git commit -m "test(hub): bridge integration against real pi: live sync, takeover, waiting, /new, quit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: App: terminal sessions in the UI

**Files:**
- Create: `app/src/lib/status.ts`, `app/src/lib/status.test.ts`
- Modify: `app/src/components/pi-header.ts` (move `headerStatus` out), `app/src/lib/slash.ts`, `app/src/lib/slash.test.ts`, `app/src/components/pi-composer.ts`, `app/src/components/pi-session.ts`

**Interfaces:**
- Consumes: `Snapshot.terminalPrompt` (Task 1).
- Produces:
  - `headerStatus(s: SessionStore): string | null` from `app/src/lib/status.ts`.
  - Extension `SlashItem`s now have `rpcOnly: true`.
  - `PiComposer.detached: boolean`.

- [ ] **Step 1: Write the failing tests**

`app/src/lib/status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../../shared/src/protocol.ts";
import { createConversation } from "../../../shared/src/reducer.ts";
import { SessionStore } from "./session-store.ts";
import { headerStatus } from "./status.ts";

const snap = (extra: Partial<Snapshot> = {}): Snapshot => ({
	sessionId: "s1", sessionFile: null, cwd: "/w", handleKind: "bridge",
	capabilities: { dialogs: "terminal", fork: false, clone: false, newSession: false, bash: false, export: false },
	conv: createConversation(),
	state: { model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, sessionId: "s1", messageCount: 0, pendingMessageCount: 0, autoCompactionEnabled: true },
	stats: null, models: [], thinkingLevels: ["off"], commands: [], dialogs: [], statuses: {}, widgets: {}, terminalPrompt: null,
	...extra,
});

describe("headerStatus", () => {
	it("says the session is open in the terminal", () => {
		const s = new SessionStore("s1");
		s.apply({ type: "snapshot", snapshot: snap() });
		expect(headerStatus(s)).toBe("open in terminal");
	});
	it("says a terminal dialog is waiting, with its title, and clears when meta says so", () => {
		const s = new SessionStore("s1");
		s.apply({ type: "snapshot", snapshot: snap({ terminalPrompt: { kind: "select", title: "Pick one" } }) });
		expect(headerStatus(s)).toBe("waiting for you in the terminal: Pick one");
		const m = snap();
		s.apply({ type: "meta", state: m.state, stats: null, statuses: {}, widgets: {}, thinkingLevels: ["off"], terminalPrompt: null });
		expect(headerStatus(s)).toBe("open in terminal");
		s.apply({ type: "meta", state: m.state, stats: null, statuses: {}, widgets: {}, thinkingLevels: ["off"], terminalPrompt: { kind: "custom", title: "" } });
		expect(headerStatus(s)).toBe("waiting for you in the terminal");
	});
	it("says nothing extra for a headless session", () => {
		const s = new SessionStore("s1");
		s.apply({ type: "snapshot", snapshot: snap({ handleKind: "rpc" }) });
		expect(headerStatus(s)).toBeNull();
	});
});
```

In `app/src/lib/slash.test.ts`, add:

```ts
it("marks extension commands unavailable in the terminal; prompts and skills stay available", () => {
	const items = slashItems([
		{ name: "ask", source: "extension" },
		{ name: "greet", source: "prompt" },
		{ name: "skill:demo", source: "skill" },
	]);
	expect(items.find((i) => i.name === "ask")?.rpcOnly).toBe(true);
	expect(items.find((i) => i.name === "greet")?.rpcOnly).toBe(false);
	expect(items.find((i) => i.name === "skill:demo")?.rpcOnly).toBe(false);
});
```

(Match the file's existing `describe` and `it` structure, and add `slashItems` to its import if it isn't imported already.)

Run: `npm test -w app`
Expected: FAIL, because `./status.ts` is missing and `rpcOnly` is undefined for extension items.

- [ ] **Step 2: Move `headerStatus` to `app/src/lib/status.ts` and teach it the terminal**

Create `app/src/lib/status.ts`:

```ts
// The one-line status under the session title. Kept out of the component so
// it can be tested without a DOM.

import type { SessionStore } from "./session-store.ts";

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
	const prompt = s.snapshot?.terminalPrompt;
	if (prompt) return prompt.title ? `waiting for you in the terminal: ${prompt.title}` : "waiting for you in the terminal";
	if (s.conv.retry) return `retrying (${s.conv.retry.attempt}/${s.conv.retry.max})…`;
	if (s.conv.compacting) return "compacting…";
	if (s.snapshot?.handleKind === "bridge") return "open in terminal";
	return null;
}
```

In `app/src/components/pi-header.ts`, delete the `headerStatus` function and add `import { headerStatus } from "../lib/status.ts";`. Then run `grep -rn "headerStatus" app/src` and point any other importer at `../lib/status.ts`.

- [ ] **Step 3: Disable extension commands on terminal sessions**

In `app/src/lib/slash.ts`, change the `rpcOnly` comment to `// unavailable while the session is open in the terminal`. In `slashItems`, map commands with the flag:

```ts
		...commands.filter((c) => !BUILTIN_NAMES.has(c.name)).map((c) => ({ name: c.name, description: c.description || c.source, kind: c.source, rpcOnly: c.source === "extension" })),
```

The composer already greys out `rpcOnly` items and toasts `Not available while open in the terminal.` when `rpcOnlyDisabled` is set, and `pi-session` sets that for bridge sessions.

- [ ] **Step 4: `continue here` in the composer**

In `app/src/components/pi-composer.ts`, add `detached: { attribute: false },` to `static properties`, `declare detached: boolean;` next to the other declarations, and `this.detached = false;` in the constructor. Change the textarea placeholder to:

```ts
placeholder=${this.detached ? "continue here" : this.streaming ? "steer pi, or hold send to queue a follow-up" : "message pi, or / for commands"}
```

In `app/src/components/pi-session.ts`, pass `.detached=${s.status === "history"}` on `<pi-composer>`, next to `.streaming`.

- [ ] **Step 5: Run tests, typecheck and build**

Run: `npm test -w app && npm run typecheck -w app && npm run build -w app`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src
git commit -m "feat(app): terminal sessions: waiting-in-terminal status, extension commands disabled, continue here

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end with a terminal pi, and docs

**Files:**
- Modify: `app/e2e/hub-for-e2e.ts`, `app/e2e/smoke.spec.ts`, `README.md`

**Interfaces:**
- Consumes: `startTerminalPi` (Task 4) and the whole stack.
- Produces: a Playwright proof of spec success criterion 2 ("A session open in the terminal TUI is watchable and promptable from the app in real time. Prompts sent from either side appear in both.").

- [ ] **Step 1: Let the e2e hub tell the spec where its pi config and socket are**

In `app/e2e/hub-for-e2e.ts`, before `Object.assign(process.env, …)`, add the following (`writeFileSync` and `tmpdir` are already imported):

```ts
// The terminal e2e test starts its own pi against this hub; it needs the same pi config and socket.
const E2E_ENV_FILE = join(tmpdir(), "pi-web-e2e-env.json"); // keep in sync with smoke.spec.ts
writeFileSync(E2E_ENV_FILE, JSON.stringify({ piBin: pi.piBin, agentDir: pi.agentDir, socketPath: join(dataDir, "bridge.sock") }));
```

- [ ] **Step 2: Write the e2e test**

Append to `app/e2e/smoke.spec.ts`, adding `import { readFileSync } from "node:fs";` and `import { startTerminalPi } from "../../hub/test/support/terminal-pi.ts";` at the top:

```ts
const E2E_ENV_FILE = join(tmpdir(), "pi-web-e2e-env.json"); // written by hub-for-e2e.ts

test("terminal: a pi open in a terminal is live in the app, and prompts from either side show in both", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	const e2e = JSON.parse(readFileSync(E2E_ENV_FILE, "utf8")) as { piBin: string; agentDir: string; socketPath: string };
	const term = startTerminalPi({ piBin: e2e.piBin, cwd: WORKDIR, env: { PI_CODING_AGENT_DIR: e2e.agentDir }, socketPath: e2e.socketPath });
	try {
		const id = (await term.call({ type: "get_state" })).data.sessionId as string;
		await page.goto(`/#/s/${id}`);
		await expect(page.locator("pi-header")).toContainText("open in terminal");

		const input = page.getByLabel("Message");
		await input.fill("from the app");
		await input.press("Enter");
		await expect(page.locator("pi-messages")).toContainText("Hello world");
		await term.records.waitFor((r) => r.type === "message_end" && r.message?.role === "user" && JSON.stringify(r.message.content).includes("from the app"));

		term.send({ type: "prompt", message: "from the terminal" });
		await expect(page.locator("pi-messages")).toContainText("from the terminal");
		await expect(page.locator("pi-messages").getByText("Hello world")).toHaveCount(2);

		await input.fill("/as");
		await expect(page.getByRole("listbox", { name: "Commands" }).locator(".opt.off")).toContainText("/ask");
		await input.fill("");

		await term.quit();
		await expect(page.getByLabel("Message")).toHaveAttribute("placeholder", "continue here");
	} finally {
		await term.quit();
	}
});
```

If Playwright can't import the `.ts` helper from `hub/`, copy `startTerminalPi` into `app/e2e/terminal-pi.ts` instead. Its `lineSplitter` and `Recorder` imports point at `../../shared/src/jsonl.ts` and `../../hub/test/support/recorder.ts`. Note the fallback in the commit message.

- [ ] **Step 3: Run the e2e suite**

Run: `npm run e2e -w app`
Expected: all tests PASS on both projects (the terminal test is skipped on phone).

- [ ] **Step 4: Document the bridge in `README.md`**

Add this section after "Configure for real use":

````markdown
## Terminal sync (bridge)

A pi started in a terminal shows up live in pi-web when it loads the bridge extension in `bridge/`. Load it for one run:

```bash
pi -e ~/workspace/pi-web/bridge/index.ts
```

Or load it for every run:

```bash
pi install ~/workspace/pi-web/bridge
```

The bridge connects to the hub at `~/.config/pi-web/bridge.sock`. Set `PI_WEB_BRIDGE_SOCKET` to use another socket, for example `.dev-data/bridge.sock` for `npm run dev -w hub`. If the hub isn't running, the bridge waits quietly and connects when it starts.

From the app you can watch the terminal session stream, prompt, steer and queue follow-ups, switch the model and thinking level, compact, and rename. Fork, clone, `!bash`, export and extension commands stay in the terminal, and extension dialogs show as "waiting for you in the terminal". If the app is running a reply in headless pi when you resume that session in a terminal, the terminal is told to wait and takes over once the reply finishes.
````

In "Test", update the `npm test` comment to `# shared + hub + bridge (node:test, real pi against a fake model) + app (vitest)`.

- [ ] **Step 5: Run everything once more and commit**

Run: `npm run typecheck && npm test && npm run e2e -w app`
Expected: all of it passes.

```bash
git add app/e2e README.md
git commit -m "test(app): e2e with a terminal pi synced both ways; README for the bridge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Manual checklist (Michael, after Task 10)

1. Restart the hub on spark (`npm run hub`).
2. In a terminal, run `pi -e ~/workspace/pi-web/bridge/index.ts` in some project.
3. On the phone, open pi.thatsit.app. The session appears with a yellow dot and "open in terminal".
4. Prompt from the phone; the reply streams in both places. Prompt in the terminal; it appears on the phone.
5. Switch the model from the phone; the TUI footer shows the new model.
6. Trigger a permission dialog in the terminal (any tool your permission extension gates). The phone header shows "waiting for you in the terminal: …".
7. Run `/new` in the terminal. The phone's URL moves to the new session.
8. `/quit` the terminal. The phone shows "continue here", and sending starts headless pi.

## After this plan

- **Plan 3: push.** VAPID keys, `/api/push/*`, `web-push`, the service-worker `push` and `notificationclick` handlers, and the settings toggle. Bridge sessions raise "needs you" on `prompt_state` as well as RPC dialogs.
- **Plan 4: deploy.** `tailscale serve`, a systemd user unit for the hub, and the bridge added to `~/.pi/agent/settings.json` `packages` (`pi install ~/workspace/pi-web/bridge`).
