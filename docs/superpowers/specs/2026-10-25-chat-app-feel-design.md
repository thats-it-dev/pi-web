# pi-web feels like a chat app

Michael, 2026-10-25: "I'd like for it to feel more like a chat app."

## Intent

Today pi-web opens to an empty "pick a session" page, a new session means a separate page
with a folder field (prefilled with the most recent folder), and every new session starts
on pi's settings default model (qwen 27b) no matter what Michael was just using. Chat
apps like Claude open straight into a conversation, keep a "new chat" button in the
corner, and remember your model. pi-web should behave that way, so the usual path is:
open the app, type, send.

## Goals

- **Launch:** open the last session if it was active within the last **2 hours**;
  otherwise open a new chat (Michael's picks).
- **New chat button** in the upper right of the header on every screen (phone and
  desktop), like Claude. It opens an empty new chat.
- **Empty chat, created on send:** a new chat is just the composer; no pi process runs
  until the first message is sent (Michael's pick). Then the hub starts pi in the chosen
  folder with the chosen model, and the message goes in as the first prompt.
- **Folder defaults to `~`**, never to the most recent folder. It can be changed in the
  chat, before the first message only (a session's folder is fixed once pi starts).
- **Last-used model:** new chats start with the model (and thinking level) Michael
  **last picked** anywhere in pi-web (Michael's pick), not pi's settings default.
- **One ＋ menu in the composer** that scales to future features (Michael: a menu, not
  chips, "if we add more tools or features later that should scale better"), opening as
  a modal sheet (Michael: "make the menu a modal").
- **Keep the context meter and tokens/t/s row at the top** (Michael), on every screen.

## Non-goals

- Changing a running session's folder.
- Changes to the Pebble watch app or its launch flow (Claude's call: out of scope; see
  "Left to the builder" for the shared hub default).
- New features behind the menu beyond what exists today (attach image, folder, model,
  approvals).
- Redesigning the messages view, sidebar list or settings page.

## Anti-goals

- A pi process started (and an empty session file written) just because the app was
  opened or the new-chat button was tapped.
- Losing the first message: if creating the session or sending fails, the text and
  images stay in the composer with a toast, as failed sends do today.
- The model shown in an unsent chat differing from the one pi actually starts with.
- A layout that hides the model: Michael checks the model, context % and t/s constantly
  (memory: "context %, t/s and model name matter"; no cost figures needed).

## Design (as decided)

Use the existing design language throughout: `tk-header`, `pi-header`'s meter + stats
row, `pi-composer`'s row, `tk-sheet` (bottom sheet on a phone, centered dialog on
desktop), kit tokens and Lucide icons. Mockup:
`.superpowers/brainstorm/3161400-1792982343/content/composer-menu-v2.html` (brainstorm
scratch, not committed; the description here is authoritative).

### Header

- ☰ (phone) on the left, title, and a **new-chat button** (Lucide `square-pen`,
  `--text-secondary`, `aria-label="New chat"`) on the right, on every route: session,
  new chat, settings, home. On desktop the sidebar's `+ new` link stays and does the
  same thing.
- The second row (context meter, `used / window (%)`, ↑↓ tokens, t/s) stays as today in
  a running session. In an unsent new chat it shows an empty meter with the chosen
  model's context window, e.g. `0 / 262k (0%) · — t/s`.
- Title of an unsent chat: `new chat`.

### Composer footer

Left to right: **＋** (opens the menu), the **model label** (`name · thinking`, primary
color, as today; in an unsent chat followed by the folder, e.g. `flash-next · medium · ~`),
then send/stop. The separate sliders (approvals) button and the separate ＋ attach button
move into the menu. Tapping the model label still opens the model sheet directly
(Michael: keep the shortcut).

### The ＋ menu sheet

A `tk-sheet` titled `this chat` with one row per feature (icon, label, current value,
›). Rows today:

1. **attach image** — opens the file picker (same rules as today: PNG/JPEG/GIF/WebP up
   to 5 MB; row hidden when the model can't take images, as the ＋ is today).
2. **folder** — value `~`; steps into a folder view inside the sheet: a path field
   (default `~`) plus the recent folders from `/api/cwds`. In a running session the row
   shows the session's folder, greyed, with "fixed once a chat starts".
3. **model** — value `name · thinking`; steps into today's model sheet content.
4. **approvals** — value `semi` etc.; steps into today's session-settings content.

"Steps into" means the sheet's body swaps to that view with a `‹` back control in the
heading. Future features are added as rows.

### New chat and first send

- Route: the new-chat button goes to a new-chat route (replacing `#/new?cwd=` and the
  `pi-new-session` page). Nothing is created on the hub yet.
- The unsent chat holds a draft: folder (default `~`), model + thinking (default: the
  hub's last-picked model), approvals (default: whatever new sessions get today).
- On send: create the session with that folder, model and thinking, navigate to it, then
  send the message (with any images) as its first prompt. Approval mode, if changed in
  the draft, is applied right after creation.
- Slash commands typed in an unsent chat: the builder decides which make sense before a
  session exists (e.g. `/model` opens the model view); anything that needs a running pi
  creates the session first or says why it can't.

### Launch

On app start with no route in the URL (`#/` or empty): fetch sessions; if the session
with the latest activity was active within the last 2 hours, open it; otherwise open a
new chat. A route in the URL (a shared or bookmarked `#/s/<id>`, `#/settings`) always
wins.

### Last-picked model (hub)

- The hub records the model (provider + id) and thinking level each time Michael picks
  one through pi-web (`set_model` / `set_thinking_level` on any session), and persists
  it in its data dir (e.g. `~/.config/pi-web/last-model.json`) so a restart keeps it.
- New sessions the hub creates get it on the command line (`pi --mode rpc --model
  provider/id --thinking <level>`). If that model is no longer available, fall back to
  pi's default silently.
- The client learns the current default (to show it in an unsent chat) from an API the
  builder picks (e.g. included in `GET /api/sessions` or a small `GET /api/defaults`),
  along with the list of models for the model view. When no pick has been recorded yet,
  show pi's default model.
- `POST /api/sessions` accepts optional `model` and `thinking` overriding the default
  (the draft's choice).

## Claude's calls after the builder check (2026-10-25)

- **First-send flow:** create the session while still on the draft (send button shows
  busy). If creation fails, nothing changes on the hub; the draft keeps its text and
  images and a toast says why. If it succeeds, navigate to the session and hand the
  pending text + images to it through an in-memory handoff (not the URL); the session
  sends them as its first prompt. If that prompt fails, the session stays (it is a real
  session in the chosen folder) and the composer's existing `restore()` puts the text and
  images back with a toast.
- **Draft picks count only when sent:** changing model/thinking in an unsent chat
  changes only that draft; the hub records it as the last pick when the session is
  created with it. An abandoned draft changes nothing.
- **Draft lifetime:** one draft per tab, in memory. Leaving it (to a session, settings)
  and coming back keeps its text, images, folder and model; a reload drops it. Tapping
  new-chat while on a draft keeps it (no-op); after a send the next new chat is fresh.
- **Validated default:** the hub's defaults API returns the last pick only if it is in the
  current model list; otherwise pi's default. The hub starts pi with exactly what the
  client sent (or that same validated default), so the screen and pi always agree.
- **Folder paths:** the hub keeps today's `POST /api/sessions` rules: `~` and relative
  paths resolve against home, a missing folder is a 400 `Not a folder: …` shown as a
  toast in the folder view. It never creates folders.
- **"Active" for launch:** the session list's latest-activity time; a session that is
  currently running or streaming counts as active regardless of age.

## Left to the builder

- Exact route name for the unsent chat, and whether "home" (`#/`) stays as a route.
- How the client gets the model list before any session runs (the model sheet today
  reads it from a running session's snapshot); a hub endpoint or a short-lived probe are
  both fine, as long as no session file is left behind.
- Whether watch-launched sessions also use the last-picked model (Claude's guess: yes,
  since it's the hub default; don't change watch UI).
- How "latest activity" is read (the sessions list already carries it).
- Updating the e2e look snapshots and tests that cover the removed new-session page.
