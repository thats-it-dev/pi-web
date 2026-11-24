# Session types: code and chat sessions in pi-web

Date: 2026-11-23. Status: design, awaiting Michael's approval.

## Intent

pi-web treats every session the same: a coding session in some folder, with the engineering standing rules, superpowers on request. Michael also uses pi for plain chat: quick questions and lookups, writing and thinking out loud, personal-assistant tasks. Those sessions clutter the coding list and carry the wrong rules. This project gives pi-web **two session types, code and chat**, a toggle in the sessions panel that selects which type you are looking at and creating, a new-session button that follows it, and type-specific defaults: code sessions keep today's behaviour with superpowers on by default; chat sessions run in the home folder with superpowers off and an assistant-focused prompt instead of the engineering rules.

## Goals

- One flip shows only code sessions or only chat sessions; the list stays grouped as today.
- Starting a session of the selected type takes one tap and needs no folder picker for chat.
- Chat sessions behave like an assistant from the first message: answer, look up, read, write and think with Michael; no repo edits or PRs unless asked.
- Code sessions start with superpowers on, so the brainstorm → plan → execute habit is the default for building.
- Existing sessions and terminal sessions keep working and appear under code.

## Non-goals

- Restricting chat sessions' tools. Michael chose "everything, but told to behave like an assistant"; the prompt steers, nothing is removed.
- Separate model or thinking memory per type. Michael chose one shared memory (the hub's last-picked model).
- Changing the superpowers package's on/off mechanics, the ＋ menu switch, or the `/superpowers` command. Only the default per type changes.
- A third type, or per-session type changes after creation.
- Touching the watch app (its sessions are created through the same hub call and count as code).

## Anti-goals

- Losing a session: a filter that hides sessions of the other type must never make one unreachable; the toggle is one tap away and the open session stays open.
- Surprising the coding flow: a code session must behave exactly as before this change, except superpowers now starts on.
- The engineering standing rules leaking into chat (pi opening PRs or running the app skill in a chat), or the assistant prompt leaking into code.
- Pasting Lucide icons into the app. Icons go into the kit.

## Constraints and facts the builder can rely on

- The hub creates sessions through `POST /api/sessions` (`hub/src/server.ts:102-128`) with `{cwd, model, thinking}` → `registry.create(cwd, choice)` → `RpcHandle.start`, which spawns `pi --mode rpc … --append-system-prompt <TLDR_PROMPT>` (`hub/src/rpc-handle.ts:253-261`, `hub/src/tldr-prompt.ts`). The only other creator is `hub/src/watch.ts:434`.
- The hub keeps no per-session metadata: `SessionIndex` (`hub/src/sessions.ts:66-106`) summarises pi's session files by (mtime, size). `SessionSummary` (`shared/src/protocol.ts:246-260`) has no type field. The hub's data dir is `~/.config/pi-web` (`hub/src/config.ts:47-49`) and already holds small JSON stores (`last-model.json`, written atomically via `writeAtomic` in `hub/src/push.ts`).
- pi 1.0.2 flags: `--append-system-prompt <text|path>` (repeatable), `--no-context-files` (disables all AGENTS.md/CLAUDE.md discovery, global included; there is no global-only switch), `--system-prompt`. The global standing rules live in `~/.pi/agent/AGENTS.md` and are engineering rules (merges, production, preview-first UI work).
- Superpowers on/off is a session entry written by the `superpowers` package on `/superpowers on|off`; default off; the app toggles it with the `set_superpowers` command, and the new-chat hand-off already sends `set_superpowers on` when the draft asks for it (`app/src/components/pi-session.ts:346-352`, `app/src/lib/draft.ts` with `superpowers: false`).
- The new-chat button is `newChatButton()` in `app/src/render/new-chat.ts` (a pasted Lucide square-pen; the kit README says icons are added to the kit, not pasted), rendered by `pi-header.ts:71` and `pi-settings.ts:197`; the sidebar has a "+ new" nav link (`pi-sidebar.ts:80`) and an empty-state "Start one" link (`:89`). All go to route `#/new` (`app/src/lib/route.ts`), which `pi-app.ts:358` renders as `pi-new-chat`.
- The sidebar lists sessions from `ListStore` (`GET /api/sessions`, cached in localStorage `pi-web:sessions`), grouped by `groupSessions` in `app/src/lib/format.ts:52-66`; the only filter today is the text search. `launchRoute` (`app/src/lib/launch.ts`) picks the latest live or recent session on a fresh load.
- `pi-new-chat` holds a per-tab `Draft` (`{text, images, files, cwd:"~", model, thinking, approval, superpowers}`) and a ＋ menu (`app/src/render/chat-menu.ts`) with folder, model, approval and superpowers rows. App settings keys: `pi-web:hub`, `pi-web:theme` (`app/src/lib/settings.ts`).
- Kit: `kit/src/icons.ts` has `PLUS_ICON`, `PENCIL_ICON` and ~60 others, hand-pasted from lucide-static 1.73.0 via the `svg()` wrapper and listed in `ICONS`; no `code`, `message-circle` or `square-pen`. `kit/src/styles.ts` has `.seg` (bordered inline-flex, `button.on` inverted), `.switch`, `.icon-btn`, `.btn`, `.btn.ghost`. The kit API is additive-only (`kit/scripts/check-api.ts`).
- Michael's rules: pi fixes apps, Claude fixes pi; headless pi test runs pin the model; multiple-choice questions; the live hub runs from the main checkout, so work happens in a worktree.

## What Michael decided

### Types and their defaults

- **Code session**: today's behaviour. Any folder (the folder picker stays), engineering standing rules apply (`~/.pi/agent/AGENTS.md` and the cwd's AGENTS.md as pi loads them today), **superpowers on by default**; the ＋ menu switch can turn it off for that chat.
- **Chat session**: always runs in Michael's home folder, no folder picker; **superpowers off by default** (switchable on); pi gets an **assistant-focused prompt** in place of the engineering rules. Same tools as today (bash, files, web search); the prompt tells pi to behave like an assistant: answer questions, look things up (web, SearXNG), read what it needs, help write and think, personal-assistant tasks and checking on the spark; don't start editing repos or opening PRs unless asked.
- Model and thinking level: one shared memory for both types (as today).

### The sessions panel

- The panel header gains an **icon-only segmented toggle** beside the brand: Lucide `code` on the left, `message-circle` on the right, with an **amber pill (`var(--primary)`) that slides** between them; kit `.seg` geometry, the active icon in `var(--bg)`, the other in `var(--text-muted)`. Accessible as a radiogroup with two labelled buttons.
- The selected type is **remembered per device** and starts as code.
- The list shows **only sessions of the selected type**, grouped and sorted as today. **Every session created before this change is a code session**; terminal (bridge) sessions are code sessions.
- Flipping the toggle filters the list and sets the type of the next new session; **the open session stays open** even if it is of the other type.
- A **filled kit `.btn` sits bottom-left of the panel** with Lucide `square-pen` and the type's name: "new code session" or "new chat". It starts a session of the selected type. On a phone the panel is a drawer and the button sits bottom-left inside it.
- The page header's "+ new" button is removed (sessions, new-chat and settings headers), as are the sidebar's "+ new" nav link and the empty state's "Start one" link, which the floating button replaces.

### Launch

- Opening pi-web with no route picks a recent session **of the selected type** (today's live-or-recent rule), else a new session of that type.

## How it gets made (my calls, open to objection)

### Type storage and transport

- The hub keeps `<dataDir>/session-types.json`, a map `sessionId → "chat"` written atomically (`writeAtomic`) when a chat session is created. Code is the absence of an entry, so every existing session and every terminal session is code without migration. The watch app's sessions are code.
- **The type follows the session.** `registry.ensure()` (resume after a reap or hub restart) looks the type up and spawns a chat session with the chat flags again; when pi switches sessions in-process (`/new`, fork, clone → `session_changed`), the registry records the new id with the parent's type, and `listSessions` falls back to `parentSession`'s type for ids the store doesn't know. So descendants of a chat are chats, descendants of a code session are code. The type store is therefore a registry-integrated map, not a one-shot write at POST time.
- `SessionSummary` gains `type: "code" | "chat"`; `listSessions` fills it from the store. `POST /api/sessions` accepts `type?: "code" | "chat"` (default code); for chat the hub ignores the body's `cwd` and uses the home folder.
- The hub marks every child it spawns with `PI_WEB_SESSION_TYPE=code|chat` in its env (beside `PI_WEB=1`), so extensions can tell the types apart without the hub.
- `DefaultsInfo` (`/api/defaults`) is unchanged; the app knows the selected type itself.

### Prompts

- `hub/prompts/chat.md`: the assistant prompt, versioned in the repo, ~25 lines in Michael's style: who Michael is to pi here (a person asking, not a repo), what to do (answer plainly; search the web or SearXNG when it helps; read files and notes when asked; help draft and think; check the spark when asked), what not to do (don't edit repos, open PRs, run the app skill or start builds unless explicitly asked; no engineering process rituals), how to end (short replies, ask one question when unsure), and **a closing safety block Michael asked for** ("if you do touch a repo or infrastructure, these still hold"): never merge or close a pull request or hand him a merge command; DNS, domains, deleting cloud resources and anything the public sees need his explicit yes for that exact action; Cloudflare goes through the `cf` CLI (and `gh` for GitHub), never wrangler or raw API calls. The process rituals (reviews, screenshots, preview-first) stay out.
- For a chat session the hub spawns pi with `--no-context-files` and `--append-system-prompt hub/prompts/chat.md` (path), in addition to the existing TLDR prompt. Code sessions spawn exactly as today.
- No `hub/prompts/code.md`: the engineering prompt is the existing global AGENTS.md plus each repo's own, loaded by pi as today.

### Superpowers default

- The `superpowers` package's default (used when the session branch has no on/off entry) becomes **on when `PI_WEB_SESSION_TYPE=code`, off otherwise** (chat children, terminal sessions, everything else stay manual-off as today). This makes "code sessions start with superpowers on" hold for sessions started from the new-chat page and for `/new`, fork and clone inside a code session alike; the `/superpowers` command and the ＋ menu switch keep working for both types. The app's draft default follows the type (`superpowers: type === "code"`) so the ＋ menu shows the right state before the first message; the hand-off's `set_superpowers on` becomes redundant for code and is dropped.

### The guard in chat sessions

- The guard reads `PI_WEB_SESSION_TYPE`. In a chat child every **block** stays (merge, push, CI polling, rewrites, discards: safety is type-independent) and so does the merge nudge, but the **stall, PR, to-do and preview nudges are off** (they are the engineering rituals the spec calls an anti-goal), and the app brief still attaches if pi does touch an app (useful, not a ritual). Tests in `guard/test/index.test.ts` for a chat child: blocks fire, nudges don't.

### The folder in chat

- For a chat session the ＋ menu's folder row is **hidden**, not disabled (a new `cwdHidden` flag on the chat-menu view beside `cwdFixed`), both on the new-chat page and on the live session page; the composer's folder chip is hidden too. `pi-session` learns the session's type from `SessionSummary.type`. Code sessions keep today's disabled-once-started row and the chip.

### App state and UI

- Selected type lives in localStorage `pi-web:session-type` (`"code" | "chat"`, default code), read by a tiny pure helper, held as state in `pi-app` and passed down to `pi-sidebar` and `pi-new-chat`.
- `pi-sidebar`: new `type` property and a `pi-session-type` event when the toggle changes; the list is filtered by `s.type === type` before `groupSessions` (sessions without `type` count as code); the floating button is a kit `.btn` with `SQUARE_PEN_ICON` + label, dispatching the existing navigation to `#/new`. The `.groups` scroll area gets bottom padding so the last row isn't under the button.
- `pi-new-chat`: receives `type`; for chat the draft's cwd is fixed to home and the ＋ menu hides the folder row (`cwdFixed: true`); `start()` sends `type` to the hub; the heading reads "new chat" or "new code session". If the toggle flips while the draft is open, the draft follows (cwd and superpowers default reset to the new type's defaults; typed text kept).
- `launchRoute` takes the selected type and considers only sessions of that type.
- `newChatButton`/`newChatStyles` are deleted; `pi-header` and `pi-settings` lose the button; `pi-sidebar` loses the "+ new" nav link and "Start one".
- Kit: add `CODE_ICON`, `MESSAGE_CIRCLE_ICON`, `SQUARE_PEN_ICON` to `kit/src/icons.ts` and the `ICONS` map from lucide-static 1.73.0 (additive). The sliding segmented control is app CSS on top of `.seg` (an absolutely positioned `::before` pill, `transform` transition ~220 ms, `prefers-reduced-motion` honoured by the kit's existing rule); not a new kit component.

### Testing

- Hub: unit tests for the type store (absent → code, chat written atomically, survives restart), `POST /api/sessions` with `type: "chat"` (home cwd, store written, spawn args include `--no-context-files` and the prompt path, env has `PI_WEB_SESSION_TYPE=chat`), resume of a chat session re-spawning with the chat flags, `session_changed` recording the parent's type for the new id, `GET /api/sessions` carrying `type` (store, then `parentSession` fallback, then code).
- Superpowers package: default on under `PI_WEB_SESSION_TYPE=code`, off otherwise; an explicit entry still wins.
- Guard: in a chat child, blocks fire and nudges don't.
- App: pure tests for the type setting helper, the sidebar filter, `launchRoute` with a type; render tests for the toggle (aria state, pill position class) and the button label; chat-menu test for the hidden folder row when `cwdFixed`.
- e2e (fake hub): toggle flips the list between a seeded code session and a seeded chat session; the button's label follows; starting a chat session lands in a session whose cwd is home and whose header shows no folder picker; `look.spec` snapshots for new-chat, chat-menu and drawer are re-pinned once the header button is gone and the toggle is in.
- One pinned-model pi run of each type (controller or Michael): a chat session answers a question without touching any repo; a code session starts with superpowers on.

## Left to the builder

- Exact toggle dimensions and the pill's easing.
- Whether the floating button hides while the sidebar's search has focus on a phone (keyboard up).
- Where `pi-web:session-type` is read on first paint to avoid a flash of the wrong list.
- The assistant prompt's exact wording (within the shape above).
- Order of PRs. Suggested: (1) kit icons; (2) hub type store + create option + prompt + env mark, superpowers default, guard behaviour; (3) app toggle, filter, button, draft defaults, folder hiding, launch; (4) tests and snapshots re-pinned.

## Out of scope but noted

- Per-type model memory, if the shared one proves annoying.
- Converting a session's type after the fact.
- A chat-specific composer (no ＋ menu folder row is enough for now).
