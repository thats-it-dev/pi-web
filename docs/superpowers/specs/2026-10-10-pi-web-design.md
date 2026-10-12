# pi-web: design

Date: 2026-10-10
Status: approved in conversation, pending written-spec review

## 1. Intent

A PWA for using the pi coding agent (pi 1.0.2, `@earendil-works/pi-coding-agent`) that runs on spark (`spark-713a`) from Michael's phone, iPad and Mac.

**What the user asked for**
- Start a session.
- See all previous sessions, whether started in the app or the CLI, and continue any of them.
- Switch models.
- See stats, including context-window usage.
- Use slash commands.
- Match the style of thatsit.dev (repo `michaelthatsit/website`).

**Decided during brainstorming**
- Used equally on phone and desktop/iPad, so the layout is responsive and neither form factor is secondary.
- Sessions open in the CLI and in the app stay **live-synced** in both directions, through a pi extension ("bridge").
- Real **push notifications** are in v1.
- Auth uses **Tailscale identity**. The hub is reachable only on the tailnet.
- The app is a static PWA hosted publicly at **`pi.thatsit.app`**. The user enters the hub's tailnet URL in the app's settings.
- There is **one hub** (spark). Settings are stored so that supporting several hubs later is a small change.
- Visual direction **"b · instrument"**: thatsit.dev's tokens and fonts, tuned for density. Mockup: https://claude.ai/artifact/8hbwyi1ouXPbHaBmiDWMai
- Structure: **a hub server with two session adapters** (headless RPC, and the terminal bridge).

**Assumptions (not stated by the user)**
- Single user (Michael). There is no multi-user model.
- "Continue" means full agent capability (tools, extensions, permission prompts), not a read-only view.

**Success criteria**
1. From the phone, Michael can open any session listed in `~/.pi/agent/sessions`, read it, and continue it with streaming output.
2. A session open in the terminal TUI is watchable and promptable from the app in real time. Prompts sent from either side appear in both.
3. Model or thinking changes, context-window stats and slash commands (pi's own plus the TUI built-ins listed in §5.3) all work from the app.
4. A push notification arrives when a run finishes, a dialog needs an answer, or a run errors, and tapping it opens the session.
5. The app reads as part of thatsit.dev.

## 2. Architecture

```
 iPhone / iPad / Mac                       spark (127.0.0.1)
┌───────────────────────┐   HTTPS (tailnet)   ┌──────────────────────────────┐
│ PWA  pi.thatsit.app   │ ── REST + SSE ────▶ │ tailscale serve :7878        │
│  (static, CF Pages)   │ ◀── Web Push ─────┐ │        │                     │
└───────────────────────┘    (via Apple/    │ │        ▼                     │
                              Google push)  └─┤  hub  (Node, :7878)          │
                                              │   ├─ RpcHandle ──stdio──▶ pi --mode rpc
                                              │   └─ BridgeHandle ◀─unix sock── bridge ext
                                              │                         inside terminal `pi`
                                              └──────────────────────────────┘
```

### 2.1 Repository layout

There is one repository, `~/workspace/pi-web`, organized as npm workspaces:

- `app/`: the PWA. Built with Vite, TypeScript and Lit web components (`pi-*` elements, matching the site's `ti-*` web-component idiom), and deployed to Cloudflare Pages (project `pi-web`, built from GitHub `thats-it-dev/pi-web`: `npm run build -w app` → `app/dist`). Fonts (Inter, Nunito, Work Sans) and color tokens come from the shared `theme/` package (`@thatsit/theme`, cloned from `@thatsit/ui`), which the build also publishes at `/theme/theme.css` for other thatsit.app apps.
- `hub/`: the Node (≥22) server. Its only runtime dependency is a Web Push library (`web-push`). Everything else uses Node built-ins.
- `bridge/`: the pi extension, a single TypeScript file loaded by pi (pi loads TS extensions through jiti) with no dependencies.
- `shared/`: TypeScript types for the wire protocols, plus the conversation reducer used by both `app/` and `hub/`.

### 2.2 The `SessionHandle` seam (hub)

```ts
interface SessionHandle {
  kind: "rpc" | "bridge";
  sessionId: string; sessionFile: string | null; cwd: string; pid: number;
  capabilities: { dialogs: "here" | "terminal"; fork: boolean; clone: boolean; newSession: boolean; bash: boolean; export: boolean };
  snapshot(): Snapshot;                       // see §3.3
  command(cmd: AppCommand): Promise<CommandResult>;
  subscribe(fn: (msg: StreamMessage) => void): () => void;
  close(): void;                               // rpc: stop child; bridge: detach only
}
```

- **`RpcHandle`** owns a child process `pi --mode rpc [--session <file>]` with `cwd` taken from the session header. It speaks pi's RPC protocol. Records are split on LF only; Node's `readline` is not used because it also splits on U+2028/U+2029.
- **`BridgeHandle`** wraps one bridge socket connection from a pi process the user started in a terminal.
- Both emit **pi's own event shapes** (the `message_*`, `tool_execution_*`, `agent_*`, `queue_update`, `compaction_*` and `auto_retry_*` events from pi's `docs/json.md`), so one reducer serves both.

Capabilities by handle:

| | RpcHandle | BridgeHandle |
|---|---|---|
| prompt / steer / follow-up / abort | ✓ | ✓ (`pi.sendUserMessage` with `deliverAs`, `ctx.abort`) |
| set model / thinking level | ✓ | ✓ (`pi.setModel`, `pi.setThinkingLevel`) |
| compact / rename | ✓ | ✓ (`ctx.compact`, `pi.setSessionName`) |
| stats / commands | ✓ | ✓ (`ctx.getContextUsage`, `pi.getCommands`, usage summed by the bridge from `ctx.sessionManager`) |
| extension dialogs answered in app | ✓ | ✗ (shown as "waiting for you in the terminal") |
| fork / clone / new session / `!bash` / export | ✓ | ✗ in v1 (`/new` from the app starts a separate headless session instead) |

### 2.3 Wire protocols

**PWA ↔ hub** (HTTPS, JSON; base URL from settings):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | `{ ok, login, hubVersion, vapidPublicKey }`. Used by settings to validate the URL. |
| GET | `/api/sessions` | Session list (§3.1). |
| GET | `/api/events` | SSE: session-list changes (`session_state` events) for the sidebar dots. |
| GET | `/api/cwds` | Known project folders, most-used first, plus `$HOME`. |
| POST | `/api/sessions` | `{ cwd, model?, thinkingLevel? }`. Starts a headless session and returns `{ sessionId }`. |
| GET | `/api/sessions/:id/history` | Messages on the active branch, read from the file. Does not start pi. |
| GET | `/api/sessions/:id/stream` | SSE: `snapshot`, then live messages (§3.3). Attaches to an existing handle and never starts one. |
| POST | `/api/sessions/:id/commands` | One `AppCommand`. Starts a headless handle if none exists. Returns `{ result, sessionId }`; `sessionId` changes after fork, clone or new. |
| POST | `/api/sessions/:id/close` | Stops a headless handle. A no-op for bridge handles. |
| POST | `/api/push/subscribe` / `unsubscribe` | Web Push subscription management. |
| GET | `/api/exports/:name` | Downloads an exported HTML file. |

`AppCommand` is a small union the hub translates per handle: `prompt {text, images?, mode: "send"|"steer"|"followUp"}`, `abort`, `set_model {provider, modelId}`, `set_thinking {level}`, `compact {instructions?}`, `rename {name}`, `fork {entryId}`, `get_fork_points`, `clone`, `new_session`, `bash {command, excludeFromContext}`, `export`, `dialog_response {id, value?|confirmed?|cancelled?}`, `clear_queue`.

**Bridge ↔ hub** (newline-delimited JSON over `~/.config/pi-web/bridge.sock`, socket mode 0600):

- Bridge → hub (types in `shared/src/bridge.ts`):
  - `hello {protocol, sessionId, sessionFile, cwd, pid, piVersion, sync: FullSync, prompt}`. `FullSync` is `{state, stats, thinkingLevels, models, commands, messages}`, everything a snapshot needs.
  - `event {event}`: pi events in RPC shapes, with `message` and `partial` stripped from `message_update` the way RPC mode's `toJsonEvent` strips them. `compaction_start` and `compaction_end` are synthesized from `session_before_compact`, `session_compact` and `session_compact_failed`.
  - `sync {sync}`: state, stats and thinking levels after `turn_end`, `agent_settled`, a model, thinking or name change; the full sync after compaction.
  - `prompt_state {prompt}`: a blocking TUI dialog opened or closed (`ui_prompt_start` / `ui_prompt_end`).
  - `result {id, ok, data?, error?}`
  - `bye {reason}`: `reason` is `session_shutdown`'s.
- Hub → bridge: `cmd {id, command}`, where `command` is `prompt`, `abort`, `set_model`, `set_thinking`, `compact` or `rename`; and `notice {text}`, shown with `ctx.ui.notify`.
- A TUI `/new`, `/resume` or `/fork` replaces pi's extension runtime, so the old connection says `bye` and a new connection says `hello` from the same pid, in either order. The hub keeps the same `BridgeHandle` for a pid through a 5 s grace period and re-keys it.
- The bridge sends `hello` again on every `session_start`, since `/new`, `/resume` and `/fork` in the TUI change the session.

### 2.4 Bridge limitations

pi's extension API has no `queue_update`, `auto_retry_*`, or view of other extensions' UI calls. On a bridge session the app therefore shows no queue chips, no "retrying (n/max)", and no other extensions' statuses, widgets or toasts. Extension dialogs are shown as "waiting for you in the terminal: <title>". Extension commands can't be run from the app, because `sendUserMessage` never dispatches them; the slash menu shows them disabled. Prompt templates and skills work (`expandPromptTemplates: true`).

## 3. Behaviour

### 3.1 Session list

- The hub scans `<sessionDir>/*/*.jsonl`. `sessionDir` follows pi's precedence: `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in `~/.pi/agent/settings.json`, then `~/.pi/agent/sessions`. Each file's summary is cached by `(mtime, size)`.
- Summary fields: `id`, `cwd`, `name` (latest `session_info`), `firstPrompt`, `userMessages`, `model` (latest assistant model, else `model_change`), `contextTokens` (last non-error assistant usage), `createdAt`, `updatedAt`, `parentSession`.
- Live data from the registry is merged in: `state ∈ idle | terminal | running | needs_you | error` and `handleKind`.
- Sessions that exist only in the registry (new, with no file yet) are included.
- The app groups the list by `cwd` (with `~` abbreviated) and supports search over name, first prompt and cwd.

### 3.2 Opening, starting, collisions, cleanup

- **Open:** if a handle exists, the app attaches to its stream. Otherwise it renders `/history`, and nothing starts until the first command.
- **First command on a session with no handle:** the hub starts an `RpcHandle`, which takes about 1.3s. Meanwhile the composer shows "starting pi…". The command runs once the handle is ready.
- **New session:** a folder picker (known cwds, or typed with `~` expansion and validated as a directory), with optional model and thinking level. `POST /api/sessions` runs, then the first prompt is sent.
- **Terminal attaches to a session held by an RpcHandle** (a bridge `hello` with a `sessionId` that already has a handle that isn't the hub's own child):
  - If the RpcHandle is idle, the hub closes it and registers the BridgeHandle in its place. Subscribers receive a fresh snapshot.
  - If it is busy, the hub sends `notice` to the bridge ("this session is running in pi-web; wait for it to finish or /quit") and keeps the RpcHandle. The bridge waits.
- **Terminal attaches to a session another terminal holds:** the hub sends `notice` ("open in another terminal; pi-web follows that one") and the bridge waits.
- **A waiting terminal is never promoted.** It loaded the session file when it started, and pi never re-reads it, so taking over later would leave the terminal and the app on a stale conversation, and its next prompt would branch silently. When the holder lets go (a busy RpcHandle settles or exits, or the holding terminal quits or moves to another session), the hub sends each waiter `notice` ("This session is free now. /resume it to continue here with the latest messages.") and stops tracking it. A settled RpcHandle stays the holder. The terminal's `/resume` of the session re-reads the file and sends a fresh `hello` from the same pid, which the hub handles like any terminal attaching: an idle RpcHandle gives way.
- **A terminal attaches while the hub is still starting an RpcHandle for the session:** the terminal wins. The new RpcHandle is closed and the command that started it goes to the BridgeHandle.
- **The hub's own children:** a bridge `hello` whose `pid` matches an RpcHandle child is ignored, because that child is already driven over RPC.
- **Bridge disconnects:** the BridgeHandle is removed. Subscribers receive `handle_gone`, the app falls back to `/history`, and the composer reads "continue here".
- **Session changes inside a handle** (RPC fork, clone or new, or TUI `/new`, `/resume` or `/fork` through `hello`): the hub re-keys the handle, and subscribers receive `snapshot` with the new `sessionId`. The app replaces its URL.
- **Cleanup:** an RpcHandle with 0 subscribers, no run in progress, no compaction and no pending dialog is closed after `idleMinutes` (default 20). At most `maxHeadless` (default 6) run at once. When at the cap, the least-recently-active idle handle closes first. If none is idle, the command returns 503 with a clear message. Bridge handles are never closed by the hub.

### 3.3 Streaming and snapshots

- On attach, and again after reconnecting or a session change, the stream sends a `snapshot`: `{ sessionId, sessionFile, cwd, handleKind, capabilities, conv, state, stats, models, thinkingLevels, commands, dialogs, statuses, widgets }`.
- `conv = { messages, partial, tools, streaming, compacting, queue, retry }` is produced by the shared reducer, which the hub keeps up to date as events arrive.
- Live stream messages: `event` (a raw pi event, which the app runs through the same reducer), `meta` (state, stats, statuses and widgets after each `turn_end`, `agent_settled`, model or thinking change, or rename), `dialog`, `dialog_closed`, `notify`, `editor_text`, `handle_gone`, `error`.
- After `compaction_end`, or an `agent_settled` that follows a compaction, the hub reloads messages and sends a new `snapshot`.
- The SSE stream sends a keep-alive comment every 20s. The app reconnects with exponential backoff (1s up to 30s) and treats the next snapshot as authoritative.

## 4. UI (direction "b · instrument")

**Tokens**, taken directly from thatsit.dev:
- Colors: `--primary #E4002b`, `--accent #FFAA00`, `--success #00843D`
- Backgrounds: `--bg #f1f1f1` light and `#171717` dark
- Text: `--text-2 #555` light and `#a1a1aa` dark
- Borders and code: `--border #555`, `--code-bg`
- Radius `0.15rem`
- Theme follows `prefers-color-scheme` through `data-theme`, the same as the site.

**Type:** Nunito for headings (lowercase labels, `letter-spacing: 0.1em` on the brand mark and group labels), Inter for body text at 14–15px, Work Sans for user prompts, and the system monospace font for code and tool lines.

**Layout:**
- Wide screens (≥ 900px): a persistent 280px sidebar and the chat pane.
- Narrow screens: the chat pane only, with the sidebar sliding in from the left at 80% width over an overlay. The header hides on scroll-down and reappears on scroll-up, as on the site.

**Sidebar:**
- `pi` wordmark with the yellow underline, a `+ new` link, and search.
- Groups by folder. Each row has a state dot (yellow = live or open in terminal, red pulsing = running, solid red = needs you), the title, a relative time, and a meta line (state · model · context %).

**Chat header (sticky):**
- Title and a model/thinking button.
- Context meter: yellow, then red at ≥ 80%, and empty with "—" right after compaction.
- `used / window` tokens and ↑in ↓out totals, plus cost when it isn't zero.
- Tapping the meter opens the stats sheet.

**Messages:**
- User prompts: a 3px yellow left rule in Work Sans.
- Assistant text: Markdown rendered by `marked`, with raw HTML escaped, links limited to `http(s):`, and code blocks on `--code-bg`.
- Thinking: one muted line ("thinking · N words") that expands on tap.
- Tool calls: compact cards (status ✓ / ✗ / spinner, tool name, one-line argument summary), expanding to show arguments and the result, with live partial output while running.
- Also shown: bash executions, compaction and branch summaries, and displayable custom messages.

**Composer:**
- An auto-growing textarea. Enter sends on fine-pointer devices; on touch devices the button sends.
- While running, the button reads **steer** and long press offers **follow-up**. A **stop** button aborts.
- Queue chips (`queue_update`) appear above the input.
- Image attach, shown only if the model's `input` includes `"image"`.
- A status line shows the cwd, extension `setStatus` texts, and handle kind ("in terminal").
- An "extensions" tray of widgets, collapsed by default.

**Sheets:** model and thinking, stats, extension dialog, fork-point picker, new session, settings (hub URL, push toggle, theme override).

## 5. Features

### 5.1 Models and thinking
The models sheet lists the available models (name, provider, context window, image badge) with the current one marked, and a segmented control for thinking levels limited to `thinkingLevels`. Both work on either handle kind.

### 5.2 Stats
The header shows the summary from §4. The stats sheet shows user, assistant and tool-call counts, tokens (in, out, cache read, cache write, total), cost, context usage, the session file, cwd and handle kind. Stats refresh on `turn_end` and `agent_settled`.

### 5.3 Slash commands
- The menu opens when the input starts with `/` and has no space yet. It filters fuzzily, using arrows, Tab or Enter on desktop and tap on touch. It merges two sources:
  - pi commands from `get_commands` (extension, prompt and skill), sent as prompt text
  - app built-ins
- Built-ins:

| Command | Action | Handle |
|---|---|---|
| `/model [query]` | open the models sheet, or set it directly on a unique match | both |
| `/thinking [level]` | open the sheet, or set the level | both |
| `/compact [instructions]` | compact | both |
| `/name [name]` | rename, or show the current name | both |
| `/session` | open the stats sheet | both |
| `/new` | new-session sheet, defaulting to the current cwd | app-side |
| `/resume` | open the sidebar | app-side |
| `/copy` | copy the last assistant text | app-side |
| `/fork` | fork-point picker, then fork | rpc |
| `/clone` | clone | rpc |
| `/export` | export HTML and download it | rpc |
| `!cmd` / `!!cmd` | run bash, including or excluding the output from context | rpc |

- On a bridge handle, rpc-only built-ins appear disabled with the hint "not available while open in the terminal".

### 5.4 Extension UI
- Dialog requests (`select`, `confirm`, `input`, `editor`) open a sheet. The answer goes back as `dialog_response`.
- Requests with a `timeout` show a countdown, and the sheet closes on `dialog_closed`.
- `notify` appears as a toast, `setStatus` in the status line, and `setWidget` in the extensions tray. All text has ANSI codes stripped.
- `set_editor_text` replaces the composer text.

### 5.5 Push notifications
- The hub generates VAPID keys once and stores them in `~/.config/pi-web/vapid.json`. Subscriptions are stored in `~/.config/pi-web/push.json`.
- Triggers, for headless (RpcHandle) sessions only, since someone running a terminal session is at the terminal:
  - a run ends with a new assistant message ("finished"). A run the person aborted sends nothing.
  - the session starts waiting on a dialog ("needs you")
  - a run's final assistant `stopReason` is `"error"` ("error")
- Nothing is sent while the app is open anywhere. The app holds `/api/events` only while it's visible (it closes the stream when hidden and reopens it, with a list refresh, when shown), and the hub holds back every push while any events stream is connected.
- Payload: `{ sessionId, title, kind }` only. No message content.
- The service worker shows the notification, and tapping it opens `/#/s/<sessionId>`.
- If the push service returns 404 or 410, the subscription is removed.
- Settings has an on/off toggle. iOS requires the app to be installed to the home screen, and settings says so.

## 6. Security

The hub runs an agent with shell access, so every request is checked. Requests failing any check get 403, without detail.

1. **Bind:** `127.0.0.1` only. Exposed solely by `tailscale serve --bg --https=7878 http://127.0.0.1:7878`.
2. **Identity:** `Tailscale-User-Login` must equal `config.allowedLogin`.
3. **Origin:** the `Origin` header must be in `config.allowedOrigins` (default `["https://pi.thatsit.app"]`, plus `http://localhost:5173` when `config.dev` is true). This applies to every route, including GET and SSE, and blocks other websites from using the ambient tailnet identity.
4. **Host:** must equal `config.hostname` (for example `spark-713a.tail9274fa.ts.net:7878`). This blocks DNS rebinding.
5. **CORS:** echo only an allowed origin, with no credentials. Preflight allows `content-type`.
6. **Bridge socket:** `0600` in a `0700` directory.
7. **App:** model and tool output is untrusted. Markdown is rendered with raw HTML escaped and URLs filtered, under a strict CSP: `default-src 'self'; connect-src <hub origin>; img-src 'self' data: blob:`.
8. **Exports:** served only from `~/.config/pi-web/exports/`, by generated filename.

Config file: `~/.config/pi-web/config.json`, with `{ port, hostname, allowedLogin, allowedOrigins, idleMinutes, maxHeadless, piBin, dev }`. The first run writes defaults and exits with instructions if `allowedLogin` or `hostname` is unset.

## 7. Error handling

| Situation | Behaviour |
|---|---|
| Hub unreachable | The cached app shell loads, with the banner "can't reach spark: is Tailscale connected?", a retry button, and the last cached session list (IndexedDB). |
| SSE drop | Reconnect with backoff and show "reconnecting" in the header. The next snapshot replaces local state. |
| Headless pi fails to start or exits | Show the session's stderr tail (20 lines, ANSI stripped) and a "restart" button. The handle is removed. |
| Bridge disconnects | `handle_gone`: fall back to history, and the composer shows "continue here". |
| Hub down while the terminal is running pi | The bridge retries the socket (1s doubling to 60s) silently. It never blocks pi startup and never prints to the TUI. |
| Command fails | Toast with pi's error text. |
| Provider error or abort during a run | Shown inline on the assistant message (`stopReason`, `errorMessage`). |
| Auto-retry | Header shows "retrying (n/max)". |
| Too many headless sessions | 503 with "Close a session first", shown as a toast. |
| Push send fails | 404/410: remove the subscription. Otherwise log it. Push never blocks anything. |

## 8. Testing

- **Reducer** (`node:test`): fixtures recorded from real pi RPC streams (text, thinking, tool calls, abort, compaction, retry). The reconstructed messages must equal the `message_end` messages.
- **Hub unit tests:**
  - session scanning against fixture JSONL (branches, compaction, names, missing header)
  - an auth-middleware table covering login × Origin × Host
  - the SSE contract (a snapshot is sent first, and again after reconnecting)
  - the AppCommand → RPC and AppCommand → bridge translation tables
- **Fake model server:** a tiny OpenAI-compatible streaming server used in tests. It returns scripted text, thinking and tool-call replies, and is registered in a temporary config directory (`PI_CODING_AGENT_DIR=<tmp>`, holding a `models.json` that points at the fake server and a `settings.json` loading only the extensions under test), so tests never touch `~/.pi/agent` or the GPU.
- **RpcHandle integration:** real `pi --mode rpc --no-session` against the fake model, driven through the hub API: prompt, steer, abort, set model, a dialog round trip (via a test extension), fork, compact.
- **BridgeHandle integration:** real pi with the bridge extension loaded against the fake model: hello, event forwarding, commands taking effect, re-hello on session switch, and no added startup delay when the socket is absent.
- **App:** component tests for the composer, slash menu and reducer-driven message list. One Playwright smoke test against the hub plus the fake model: open, start a session, stream, switch model, `/compact`.
- **Manual checklist:** installing to the iOS home screen, push received on iOS and dismissed, Chrome desktop access from `pi.thatsit.app` to the tailnet hub.

## 9. Delivery milestones

0. **Spike (dropped 2026-10-11):** the plan was a static page fetching a tailnet `tailscale serve` endpoint from Chrome, Safari and iOS. It checks Local Network Access and CORS with Tailscale identity headers. **If it is blocked, the app is served from the hub itself (same origin)**, and §2.3 and §6.3 change accordingly before any other work. We skipped it once Plan 1 was built: the deployed app at `pi.thatsit.app` is the probe. If a browser blocks it, add the same-origin fallback then.
1. Hub (RpcHandle, sessions, auth) plus the app (list, view, continue, start, models, stats, slash commands, dialogs) in style b, run locally.
2. Bridge extension with live terminal sync.
3. Push notifications.
4. Deploy: Cloudflare Pages site at `pi.thatsit.app` (Git-connected; `master` is production), the `tailscale serve` entry, the bridge added to `~/.pi/agent/settings.json` `packages`, and a systemd user unit for the hub.

## 10. Out of scope (v1)

Multiple hubs, multiple users, `/tree` navigation, `/share`, `/login`, editing settings or `models.json` from the app, offline composing or queueing, and rendering the TUI's custom tool renderers.
