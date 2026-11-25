# Preview panel: live previews in the pi-web aside before a PR

Date: 2026-11-23. Status: design, awaiting Michael's approval.

## Intent

pi builds web apps (the thatsit.app apps, mockups, prototypes) and today the only ways Michael sees the result are a Playwright screenshot in the reply or the Cloudflare Pages preview once a PR exists. Both are slow round trips for visual work, and the screenshot can't be clicked. This project gives pi-web a **Preview** tab in the aside that loads a live dev server pi started in the app's checkout, reachable over the tailnet, so a change can be looked at, poked and iterated on within seconds. pi gets a tool to start that server and open the panel, and is told to make it the default step before any UI PR, and to use it for mockups and prototypes before real code.

## Goals

- A visual change is viewable in pi-web within seconds of pi making it, with live reload, no PR.
- The preview is a real browser view: clickable, resizable, viewable at phone and tablet widths from a desktop.
- pi opens it on its own when it has something to show, and knows to use it for mockups, prototypes and pre-PR checks.
- Works on desktop and iPad inside pi-web; on a phone the URL hands off to the in-app browser.
- PR / Pages preview links already shown in the Progress tab open in the same panel.

## Non-goals

- Replacing the screenshot step in the thatsit-app skill. Screenshots remain how pi *itself* looks at the app; the panel is how Michael looks.
- Replacing Pages PR previews or the spark-gateway PR previews. Those stay the review surface once a PR exists.
- Previewing non-web work (CLI output, Pebble emulators).
- A URL field Michael types into, or pi opening arbitrary web pages in the panel. Michael chose: dev server previews plus PR preview links only.
- "Talk-back" buttons in the panel (send screenshot to pi, stop server). Michael picked the header without them.
- Public exposure. Previews are tailnet-only, never Funnel.

## Anti-goals (what would make this a failure even if it works)

- The panel stealing the aside so Progress is lost. Both must remain reachable (tabs).
- A preview server that outlives its usefulness: ports piling up, `tailscale serve` entries left behind, dev servers running for days.
- The hub becoming a reverse proxy for app content. The hub stays the chat API; previews are separate Tailscale serve ports.
- Pushing pi into a preview-before-everything habit so hard that it opens previews for non-visual changes.

## Constraints and facts the builder can rely on

- pi-web app origin is `https://pi.thatsit.app` (Cloudflare Pages). Its CSP is a build-time meta tag from `app/src/lib/csp.ts`, currently `default-src 'self'` with no `frame-src`, so iframes of other origins are blocked until that changes.
- The hub listens on 127.0.0.1:7878 and is exposed by `tailscale serve` at `https://spark-713a.tail9274fa.ts.net:7878`. Tailscale's operator user is `michael`, so `tailscale serve` works without sudo from pi. One host cert covers every port. `tailscale serve status --json` lists current entries.
- spark-gateway uses `tailscale serve` ports 9500+N for PR previews. This project must use a disjoint range.
- Apps are Vite 8 (`"dev": "vite"`, default port 5173, no port in `vite.config.ts`). Vite blocks requests whose Host isn't allowed; the env var `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` adds hosts without touching the app's config. Vite's HMR client connects to the page's own host and port when no `server.hmr` is configured, so HMR works through a serve proxy on a different port.
- Apps' `public/_headers` CSP has no `frame-ancestors` and no `X-Frame-Options`; Vite dev serves no such headers either. The app side needs no change to be iframed.
- The kit shell (`kit/src/tk-shell.ts`, `kit/src/panels.ts`) has exactly two panels, `nav` and `aside`, a fixed `--aside-w: 300px` grid column, no resize code, breakpoints `PHONE_MAX = 899` and `WIDE_MIN = 1200`, and docks the aside only in wide mode (or mid mode with no nav). The side-panels spec listed resizable widths as a non-goal; this project reverses that.
- The aside currently holds a single child, `pi-progress-panel`, mounted by `pi-app.ts` only while progress is non-empty.
- Agent → UI flow: tools are registered in the bridge extension (`bridge/index.ts`, before the `PI_WEB` early return so headless children get them), forwarded by the hub as raw `tool_execution_*` events over SSE, reduced by `shared/src/reducer.ts`, and rendered by name in `app/src/render/messages.ts` (`show_image` is the model to copy).
- Background processes: `bg/jobs.ts` spawns detached process groups, kills them on `session_shutdown`, and the hub reaps idle headless pi children after `idleMinutes` (default 20). The hub refuses `new_session`/`fork`/`clone` while bg jobs run (`BG_JOBS_BLOCK`).
- pi learns about features through tool descriptions, SKILL.md files, `~/.pi/agent/AGENTS.md` (standing rules; today it says "Deploy to a preview URL, show it, and ask"), and guard nudges from `guard/index.ts`. pi reads skill bodies rarely, so the guard hands app sessions their rules at the first tool call.
- Michael's rules: pi fixes apps, Claude fixes pi (this project is pi-web, bridge, bg, guard, skills; never `~/workspace/apps`). Cloudflare work goes through `cf`, not wrangler. Pin the model in pi test runs.

## What Michael decided

### The panel (desktop)

- The aside gets **two tabs: Progress and Preview**. Opening a preview switches to Preview. (There is no Progress badge today; if one is added later it lives on the tab.) Either tab can be shown when the other is empty; the aside is present if either has content.
- Preview tab layout, top to bottom: a **header strip**, the **iframe**, a **status line**.
  - Header strip: the URL (truncated, monospace), **viewport presets fit / 390 / 768**, reload, **snap** (⇔), **pop-out** (⧉).
  - Viewport presets lay the iframe out at that CSS width, centred, scaled down with `transform` if the panel is narrower; `fit` fills the panel.
  - Status line: server alive dot, app name, uptime. When the server is gone: a plain "stopped" state with a note that pi can restart it.
- **Resize, option D**: a **drag handle** on the panel's inner edge for any width, with a chat floor (~360px); width remembered per device in localStorage; double-click the handle resets to default. **Snap** cycles narrow (today's 300px) → half → full; full collapses chat to a thin strip that keeps the composer reachable. **Pop-out** opens the same URL in a new browser tab.
- When pi opens a preview, pi-web opens the aside if hidden and switches to Preview. If the same URL is announced again, the iframe reloads rather than re-mounting.

### iPad

- While the Preview tab is active, the aside **docks side by side even at drawer widths (900–1199px)**; chat squeezes; snap cycles half ↔ full. No drag handle on touch. Closing Preview (or switching to the Progress tab) returns to today's drawer behaviour.

### iPad portrait and other tablets (600–899px)

- Below the kit's 900px dock point there is no room for side by side. Michael chose: the **Preview tab takes the whole screen**, with a bar at the top holding "Back to chat", the URL, reload and pop-out. Chat is one tap away; the header's aside button (with its live dot) brings the preview back.
- No iPadOS detection. The split between "tablet" and "phone" is width alone (my call): **600px**. Every iPad is 744px or wider in portrait; every iPhone is 440px or narrower. Viewport presets are hidden in this mode (the screen is the viewport).

### Phone (< 600px)

- **No iframe on a phone.** The tool call renders as a **card in pi's reply** with the app name, URL, and an Open button. Tapping it opens the URL in the in-app browser (a standalone PWA opening an external origin on iOS shows the in-app Safari sheet; `target="_blank"` on a real anchor is the mechanism, so it works as a user gesture and isn't popup-blocked).
- The **header's aside button shows a dot while a preview is live** and, on a phone, opens the Preview tab of the drawer, which shows the card (URL, Open, status) rather than an iframe.
- The card also renders on desktop and tablets, where tapping it focuses the Preview tab.

### Behind the URL

- **pi starts the app's own dev server** in its checkout. Live reload comes with it.
- **Lifecycle: tied to the pi session, which a live preview holds open.** Since 2026-11-24 the hub's idle reaper skips a session whose `preview` status is set (`SessionHandle.hasPreview`), so the page stays up while Michael looks; a session holding a preview is still the last pick when `maxHeadless` needs room. When the pi process does end, `killNow` removes the tailscale serve entry synchronously (the queued async stop never ran before the process was gone, leaving `10600 → dead port` on 2026-11-24), and the bridge records each open preview as a `pi-web-preview` session entry: a resumed session reopens its last preview (if under 24 h old and not stopped) on `session_start`.
- **PR / Pages preview links** in the Progress tab open in the Preview tab instead of a new browser tab.

### Agent habit

- **Default step before any UI PR.** Standing rule in `~/.pi/agent/AGENTS.md` and the thatsit-app skill: after the first visual change, open a live preview, iterate there with Michael, and only then run `pr`. The guard nudges when a UI PR is attempted in a session where no preview was opened.
- Mockups and prototypes before code go through the same panel.

## How it gets made (my calls, open to objection)

### The tool

One new pi tool in the bridge extension, `preview`, with two forms:

- `preview({ cwd })` — start the app's dev server in `cwd` (if not already running for this session), expose it, open the panel. Reads `package.json` for a `dev` script; runs it with `PORT`-less Vite on `127.0.0.1` at a free local port, `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=spark-713a.tail9274fa.ts.net` in the env. Waits until the port answers (timeout 30s), then announces.
- `preview({ dir })` or `preview({ file })` — static-serve a folder (or the folder of a single HTML file) for mockups and prototypes with no app. Served by a tiny static server inside the bridge extension (no new dependency), with live reload by polling mtimes, so pi can rewrite a mockup and the panel refreshes.
- `preview({ stop: true })` stops this session's preview server and removes its serve entry.
- Result: `{ url, label, kind: "dev" | "static", port }` in `details`, plus a short text content for the model ("Preview open at https://…; tell Michael to look and ask what to change."). The UI renders it from `details`.

Mockup files for the static form live **outside the repo**, under `~/.pi/agent/tmp/previews/<session-id>/`, so nothing lands in the checkout. The tool creates the folder and returns its path when called with no `dir`, so pi can write into it.

### Exposure

- A **preview port range 10600–10649**. spark-gateway allocates `9500 + PR number` for PR numbers up to 499, so everything from 9501 to 9999 is its; nothing in the live serve config sits above 9999. The tool picks the lowest free port, runs `tailscale serve --bg --https=<port> http://127.0.0.1:<local>`, and records the pairing. Stop runs `tailscale serve --https=<port> off`.
- Reconciliation on start: entries in 10600–10649 whose local port no longer listens are removed, so a crash never strands a port. The tool never touches a port outside its range.
- The URL is always `https://spark-713a.tail9274fa.ts.net:<port>`, derived from `tailscale status --json` (`Self.DNSName`, which comes back with a trailing dot to strip), never hard-coded.

### Lifecycle mechanics

- The dev server is a bg-style detached process group tracked by the bridge (reuse `bg/jobs.ts` spawn/kill helpers or move them to `shared`), killed on `session_shutdown`, which the hub's idle reaper already triggers.
- **Preview servers do not count as blocking background jobs** for `new_session`/`fork`/`clone`. Switching session stops the preview instead of refusing the switch. (Blocking is right for `pr-wait`; wrong for a server that is only there to be looked at.) Concretely: the preview must not publish under the `bg-jobs` status key, since the hub keys `BG_JOBS_BLOCK` on it; it gets its own status key.
- **Subagent workers don't get the tool.** Pair workers inherit `PI_WEB=1`; the tool refuses under `PI_SUBAGENT_CHILD` with a message to hand the URL request back to the orchestrator, because a worker's server would die with the worker and its result never reaches the parent conversation.
- The panel polls the preview URL's health lightly (a HEAD every 15s while the tab is visible) to drive the status dot; a failed poll flips it to "stopped".

### UI state

- The preview is **derived from the conversation**, like progress: the reducer keeps `preview: { url, label, kind, at }` from the latest successful `preview` tool call (and clears it on a `stop`). Reopening a session restores the panel from history; the health poll then says whether it is still alive.
- A new app-side component `pi-preview-panel` owns the header, iframe and status line. The aside's tab bar is a small shared piece (`pi-aside-tabs`) mounted by `pi-app.ts` with both panels as children; the kit shell is unchanged except for the width work below.
- **Kit shell changes** (kit, so other kit apps get them): `--aside-w` becomes settable from the app; a `resizable` attribute adds the drag handle and persists width under the shell's `store-key`; a `dock-aside` attribute forces docking in mid mode (used while Preview is active); snap-to-full is an app-level width value the shell honours; a `fullscreen-aside` mode covers the 600–899px tablet case. The kit side-panels spec's non-goal is superseded here.
- **The chat floor wins.** In mid mode with the nav docked, "half" would break the 360px floor; the shell clamps the aside so the floor holds, and if even narrow doesn't fit, the nav un-docks first.
- **CSP**: `frame-src https://*.ts.net:* https://*.pages.dev https://*.thatsit.app` added to `app/src/lib/csp.ts`. Nothing else in the CSP widens.
- Pop-out and the phone Open button use a real `<a target="_blank" rel="noopener">`.

### Progress tab links

- `render/progress.ts` PR preview links dispatch an "open in preview" event instead of navigating; the Preview tab loads them like a dev server URL, with the status line reading "Pages preview" and no health poll. Pop-out still opens the real tab.

### Teaching pi

- Tool description written for the moment of use: "Michael can see this in pi-web's Preview panel. Call it after the first visual change and before any PR; call it with `dir` for mockups and prototypes."
- `skills/thatsit-app/SKILL.md`: the "look" step gains "open a preview for Michael" before "pr"; the pr step says "only after Michael has seen the preview or waved it off".
- `~/.pi/agent/AGENTS.md` standing rule becomes: "UI work: open a live preview first, iterate with Michael there, then PR. Deploy to a Pages preview URL, show it, and ask." (Edit outside the repo; the guard's `appBrief` already hands app sessions their rules.)
- Guard nudge: when `thatsit-app.ts pr` runs in a session whose UI files changed (reuse the guard's existing git-snapshot `uiChanged` / screen-gate machinery, since in the pair the orchestrator never edits files itself) and `preview` was never called, inject one nudge ("No live preview was opened this session. Open one and ask Michael before the PR, unless the change isn't visual."). One nudge per session, never a BLOCK.
- `bridge/skills/preview/SKILL.md` for the "how to" (static mockups folder, viewport presets exist, phone hand-off).

### Testing

- Reducer and panel-state logic: unit tests in `shared` (preview derived from tool results; cleared on stop).
- Kit shell: tests for width persistence, snap cycle, `dock-aside` in mid mode (there are existing panels tests to extend).
- Tool: tests against a fake `tailscale` on PATH for port picking, reconciliation, and stop; a real run against the `fret` checkout as the manual end-to-end check (dev server up, URL answers 200 over the tailnet, HMR fires on a CSS edit).
- Playwright e2e in `app`: a `preview` tool result in a fixture session renders the card and the Preview tab; phone viewport renders the card and no iframe.
- A pinned-model pi test run (`pi -p` with the model pinned per Michael's rule) on a throwaway app branch: pi makes a visual change, calls `preview`, and asks Michael to look.

## Left to the builder

- Exact drag-handle hit area, snap thresholds, and the "thin strip" width in full mode.
- How the iframe scaling at 390/768 handles height (likely: iframe height = panel height / scale).
- Whether health polling uses `fetch` with `no-cors` or an `<img>`/`onload` trick given the preview origin has no CORS headers.
- Reconciliation details for `tailscale serve` entries and how the tool detects "already running for this session".
- Static server implementation (plain `http` module, MIME table, mtime polling endpoint).
- Where the aside tab bar lives when only one tab has content (show one tab, or hide the bar).
- Order of PRs. Suggested: (1) kit shell width work, (2) tool + exposure, (3) panel + tabs + CSP + card, (4) skill/AGENTS/guard.

## Out of scope but noted

- A per-app preview that outlives the session (a "pinned" dev server) could come later if the restart-on-demand feels slow.
- Reusing the running preview server for the skill's `screenshot` CLI instead of its own Vite instance.
