# pi-web watch UI — Pebble-native rewrite

Date: 2026-10-27. Status: draft for review.
Related: `~/workspace/ring-profile/docs/superpowers/specs/2026-10-27-ring-profile-design.md`
(the ring-profile design, approved; it depends on this project's query contract).

## 1. Intent

Replace the pi-web watch UI with a fresh one that looks and behaves like
Pebble's own apps. Michael finds the current UI, including the unmerged
`feat/pebble-native-ui` redesign:
- hard to read;
- too many presses;
- cluttered;
- not Pebble-like.

The new app does three things from the wrist:
- **check on sessions**;
- **start or continue something** (through the ring);
- **answer queries**: pi approval requests, and ring-profile's follow-up
  questions.

The reference is the native notification UI and the fitsky action menu
(`~/workspace/pebble-ui/examples/fitsky-patterns`, screenshots
`screenshots/emery/actionmenu*.png`). The text fills the screen, Select slides
out a black action menu, Up/Down move through it, and Select picks.

## 2. Goals, non-goals, anti-goals

Goals
- A new watchapp for the Pebble Time 2 (emery) with three screens: session
  list, session, query (§4).
- A hub-level **query** contract shared by pi dialogs and ring-profile (§6).
- A native Pebble notification for a new query while the app is closed, whose
  action opens the app on that query. Auto-launch is the fallback (§7).
- **Finished and errored turns also alert** when the app is closed (Michael's
  call). They use the same notification path, and the action opens that
  session (§4.2).
- Light and dark themes, chosen in the phone's Clay config page with the hub URL (§4.4).

Non-goals
- A watchface. The pi-web watchface (`watch/face`) is retired.
- Watch dictation as an input. Spoken input comes from the ring (§5).
- Pebble Round 2 (gabbro) layouts. The old app supported it; v1 targets emery
  only (Claude's call; round can follow).
- ring-profile itself. It's a separate project that consumes the query
  contract.

Anti-goals
- Text below 14 px, or body text below 18 px.
- More than two presses to answer the common case of a query.
- Anything that looks like a terminal or a web page ported to the watch.

## 3. Visual language (Michael's choices, from mockups)

- **Fonts:** Gothic Bold for all words; **LECO for digits** (clock and times,
  counts, durations). PebbleOS's LECO fonts contain only digits and a few
  symbols. Checked in `coredevices/PebbleOS`
  `resources/normal/base/resource_map.json`: e.g. `LECO_20_BOLD_NUMBERS` covers
  `0-9 : / . , ° A P M H B L T I N -`. So LECO is used only where the string
  fits its character set.
- **Text** is left-aligned. Query and reply body is about 18–20 px Gothic Bold
  (`GOTHIC_18_BOLD` / `GOTHIC_24_BOLD`; the builder picks per screen for
  readability). Secondary lines are 14 px bold at the smallest.
- **Palette:** thatsit.app's colours (`~/workspace/ui/src/styles/root.css`)
  snapped to the Time 2's 64 colours:

  | role | thatsit | watch |
  |---|---|---|
  | waiting on you | `--primary #FFAA00` | `#FFAA00` (exact), black text |
  | pi / running | `--secondary #0032A0` | `#0055AA` |
  | ring-profile | `--success #00843D` | `#00AA55` |
  | error | `--accent #E4002B` | `#FF0055` |
  | done | — | light `#AAAAAA` / dark `#555555` |

- **Header bar** on query and session screens: coloured by source or state,
  with a white label on the left and a LECO time on the right. The bar turns
  orange (black text) while the screen is waiting on Michael.
- **Action menu:** black, with a strip down the left edge in the screen's
  colour; the selected item is white and the rest are dark grey, in Gothic 24
  Bold. Use pebble-ui's `ActionMenu` (`~/workspace/pebble-ui/modules/ActionMenu.js`)
  rather than writing a new one.
- **Themes:** Light (white background, black text) and Dark (black
  background, white text). Header colours, status dots, the selected row and
  the action menu are the same in both. The theme is chosen on the phone (§4.4).
- Mockups: `pi-web/.superpowers/brainstorm/280854-1793118289/content/`
  (`query-flow-v2.html`, `sessions.html`, `thatsit-palette.html` option A,
  `dark-mode.html`). The fonts there are browser stand-ins.

## 4. Screens and buttons

Buttons follow Pebble convention: Back goes back (or out of the app from
Home), Select opens the action menu, and Up/Down scroll or move.

### 4.1 Home: session list
- A status bar with the time in LECO.
- One row per pi session: name (Gothic Bold), a status line ("Waiting ·
  approval", "Running · 4:12", "Done · 13:40", "Error"), and a status dot
  (orange waiting, blue running, grey done, red error).
- Order: sessions waiting on Michael first, then by most recent activity.
- The selected row is highlighted in blue.
- Select opens a session. If a session has a pending query, Select opens the
  query instead.

### 4.2 Session
- A blue header bar with the session name and the time of the last reply.
- The agent's **last reply**, full-screen; Up/Down scroll it.
- Select opens the action menu: **Continue**, **Stop**, **Model**,
  **Archive**. Model opens a second action menu listing the available models,
  as `/api/watch/models` returns them today.
- **While a session is open, the ring's agent gesture targets it** (§5).
- The reply updates in place when the session finishes a turn. Live
  streaming isn't required.

### 4.3 Query
- Full-screen text under a header bar: source label (`pi · <session>` or
  `ring · follow-up`) and the time it was asked. The bar is orange while the
  query waits, and blue (pi) or green (ring-profile) in its menu strip.
- Up/Down scroll long text.
- Select opens the action menu with the query's options, then **Skip**
  always last. **Skip on a pi dialog only hides it from the watch** (Michael's
  call). pi keeps waiting, and the dialog stays answerable in the web app.
  This is today's `dismiss`. Skip on a ring-profile query is a real skip. For a pi approval the options are what the dialog offers
  (e.g. Allow / Always allow / Deny). For a ring-profile probe they're 2–4
  choices.
- A ring answer (§5) clears the query as soon as the hub receives it, **if it
  matches**. The watch then goes back to where Michael was. If a ring note
  doesn't clearly match a pi dialog's options, **nothing is approved or
  denied**. The query stays up, and the watch shows a short "Didn't catch
  that" line (Michael's call).
- One buzz when a query appears.
- If several queries are pending, they queue: the next shows after one is
  answered. Home's ordering keeps them visible.

### 4.4 Settings (phone, Clay)
Settings live in the **Clay** config page in the Pebble phone app, not on the
watch (Michael's call). They are:
- **Hub URL** (the Tailscale address);
- **Theme** (Light / Dark).

Keep the existing Clay setup in `watch/app/src/pkjs/config.js` and `index.js`
(`HUB_URL`, `DARK`, saved via `webviewclosed`). Restyle or extend it only if
needed. The theme reaches the watch as today and persists there.

## 5. Ring input (decided in the ring-profile design)

The Index ring has two webhooks, both received by the hub:
- **Agent webhook** (existing `POST /api/index/webhook`):
  - if a query is **on screen in the app**, the note answers it (and clears it
    if it matches; §4.3). This includes one opened from a notification. A query
    that is merely pending, but not being looked at, is never answered by the
    agent gesture (Michael's call: "query on screen");
  - otherwise, **if a session is open on the watch, the note is sent to that
    session as a prompt**;
  - otherwise it starts a new pi session (`startRingSession`).
- **Notes webhook** (new): goes to ring-profile. It can answer and clear a
  *ring-profile* query only; ring-profile decides whether it was really an
  answer.

The watch app has to tell the hub what is on screen: a query id, a session
id, or Home. The existing `/api/watch/showing` endpoint is the natural place.
When the app closes or disconnects, the hub treats nothing as shown.

## 6. Hub: the query contract

**Ownership** (Claude's call, resolving an overlap between the two designs):
this project builds the query contract, the pi-dialog mapping, the
agent-webhook routing (§5), the localhost raise/outcome API, and its tests.
ring-profile builds only the notes webhook and the forwarding to its service,
on top of this contract.

A **query** generalises today's pending dialogs (`watch.ts` `pending()`), so
that pi sessions and outside services like ring-profile both raise them. The
builder designs the exact API. It must provide:
- `id`, `source` (`pi` with a sessionId, or `ring-profile`), `text`, `options`
  (0–n labels), Skip always available, `createdAt`, and a timeout (default 10
  min for ring-profile; pi dialogs keep their current lifetime);
- an **outcome** reported back to the raiser: one of the following.
  - `option` (which one);
  - `skip`;
  - `ring-answer` (with the transcript);
  - `cleared-by-ring`, for ring-profile when the notes webhook cleared it;
  - `expired-delivered` / `expired-undelivered`. A query counts as
    **delivered** once the app showed it, or a notification or launch for it
    reached the phone's Developer Connection successfully (Claude's call). The
    hub records delivery per query. The ring-profile design's
    "connected/disconnected" maps onto this;
- delivery over the existing watch WebSocket (`/api/watch/stream`), which
  replaces the dialog-specific frames;
- a way for ring-profile (localhost HTTP) to raise a query and get its
  outcome by callback.

**Web app open:** while Michael is viewing pi-web in a browser
(`viewers.watching()`), **pi** queries are held back from the watch, as today.
**ring-profile** queries are never held back (Claude's call).

The watch-facing protocol may change freely, because the old app is retired.
The phone side (PebbleKit JS in the app) should be kept small: it relays
frames and nothing more.

## 7. Arrival when the app is closed

PebbleKit JS stops when the watchapp closes, and the Core Devices plugins API
can't post notifications. So alerts must come from the hub through the phone's
**Developer Connection** (WebSocket, port 9000). pi-web already uses it to
launch the app (`hub/src/watch-launch.ts`, an AppRunState frame).

1. **Preferred: native notification.** The hub sends a BlobDB notification
   insert through the Developer Connection. The notification's parent is the
   app's UUID, and it has an **OpenWatchApp** action carrying a launch code
   that names the query. The watch shows a normal Pebble notification (one
   buzz); choosing the action opens the app straight onto that query. The
   app reads the launch code from `watch.launch.arguments`, and PebbleOS
   (`fw/services/timeline/timeline.c`) supports OpenWatchApp on notifications.
2. **Fallback: auto-launch** the app onto the query (the existing
   `launchOnPhone`).

**Unknowns that plan step 1 must test on Michael's phone and Time 2:**
- whether the Developer Connection accepts frames while the Pebble app is in
  the background, especially on iOS;
- whether the phone's BlobDB sync leaves hub-inserted notifications alone;
- the exact launch reason and arguments Alloy reports.

Whichever path works becomes the default. Both may stay, behind a hub config
switch. The same path carries finished and errored turn alerts (§2), with a
launch code that names the session.

The research behind this (2026-10-27) is not hardware-verified:
coredevices/mobileapp `test-apps/plugins.md` and `PKJSInterface.kt` /
`CompanionAppLifecycleManager.kt`; coredevices/PebbleOS
`fw/services/timeline/timeline.c`; Moddable `pebble-examples` `helloinfo` and
`hellowakeup` for `watch.launch`.

## 8. Constraints

- **Alloy (Moddable JS)**, emery, built with the toolchain in
  `watch/README.md` (SDK 4.33.1 on the spark). Mind the emulator memory budget
  and the gotchas in the `using-pebble-ui` skill.
- **Build on pebble-ui** (`~/workspace/pebble-ui`) for menus, the action menu
  and the status bar. Add generic widgets to the library rather than to pi-web
  when they're reusable.
- **Branch:** a fresh branch from `master` in pi-web. Delete `watch/face` and
  the old `watch/app` UI in that branch. Leave `feat/pebble-native-ui` and
  `wip/watch-pebble-ui-rewrite` untouched.
- Auth stays tailnet identity only (standing decision). No tokens.
- Keep the hub's existing non-watch behaviour (web app, sessions) unchanged.

## 9. Decided vs. left to the builder

Decided by Michael:
- scrap the existing UI and lean on the Pebble UI examples;
- full-screen readable queries answered with the buttons and action menu;
- a ring answer clears the query, for pi sessions too;
- the fitsky-style action menu;
- left-aligned, smaller text with a coloured header bar for the source;
- the thatsit palette;
- Gothic plus LECO digits (option A);
- light and dark themes;
- settings (hub URL, theme) in the Clay phone config, not on the watch;
- the session list as home;
- the last reply on the session screen;
- the open session is the ring's target;
- native notification first (if possible), auto-launch as fallback, tested
  later as plan step 1;
- finished and errored turns alert too;
- Skip on a pi dialog only hides it;
- an unmatched ring answer leaves the query up;
- the agent ring gesture answers only a query on screen;
- drop the watchface;
- a fresh branch.

Claude's calls:
- emery only for v1;
- the action-menu items for sessions (Continue / Stop / Model / Archive);
- queries queue one at a time;
- `/api/watch/showing` carries the open session;
- this project owns the hub query contract;
- "delivered" means the notification or launch reached the phone, or the app
  showed the query;
- pi queries are held back while the web app is open, ring-profile queries
  aren't.

Left to the builder:
- the exact Gothic sizes per screen;
- the query API shape and the watch protocol;
- how "Continue" is phrased to pi;
- how archived sessions are hidden;
- error and empty states (no sessions, hub unreachable). These should be one
  plain full-screen message in the same style.

## 10. Plan step 1 (required)

A throwaway spike: send one test notification with an OpenWatchApp action and
one auto-launch to Michael's Time 2 through the Developer Connection. Do it
with the Pebble app in the foreground and in the background, and record what
happens. Michael watches his wrist. The results settle §7 before the rest of
the plan is built.
