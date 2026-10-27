# pi-web watch

One Pebble Alloy project (Moddable SDK on PebbleOS) for emery (Pebble Time 2) only: the watchapp in `watch/app/` (see `app/CLAUDE.md`). It is built on the pebble-ui widget library, a git submodule at `watch/pebble-ui`; run `git submodule update --init` before the first `pebble build`. The old watchface, the gabbro (Round 2) target and the earlier views are gone (the watch UI rewrite, `docs/superpowers/specs/2026-10-27-watch-ui-design.md`).

The app talks to the hub through a PebbleKit JS phone side (`app/src/pkjs/`). `watch/shared/` holds the modules shared by the watch side and the phone side. `npm run test:watch` (`node --test watch/app/test/`) tests the app.

Shared modules live in `watch/shared/` (`js/` watch-side via manifest paths, `pkjs/` phone-side via relative `require`). The plain relative `require("../../../shared/pkjs/hub")` bundles fine with the SDK webpack (no symlink or copies needed).

## Toolchain

Verified on the spark (aarch64 Linux, 2026-10-16). pebble-tool runs on Python 3.13 so that PebbleKit JS (the phone-side code in `src/pkjs`) runs in the emulator:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh     # uv 0.13.1 -> ~/.local/bin
export PATH=$HOME/.local/bin:$PATH

# 1. pebble-tool on Python 3.13, without the stpyv8 dependency (it has no aarch64 wheel on PyPI
#    and its sdist does not build: "ModuleNotFoundError: No module named 'settings'").
echo 'stpyv8; sys_platform == "never"' > overrides.txt
uv tool install --python 3.13 --force --overrides overrides.txt pebble-tool   # Pebble Tool v5.0.40

# 2. The real STPyV8, from a fork that publishes a prebuilt aarch64 wheel (CPython 3.13 only, glibc >= 2.39).
gh release download v13.1.201.22 -R andrwj/stpyv8
uv pip install --python ~/.local/share/uv/tools/pebble-tool/bin/python \
  ./stpyv8-13.1.201.22-cp313-cp313-manylinux_2_39_aarch64.whl

# 3. The SDK and its own venv, which must be the same Python minor version as pebble-tool.
pebble sdk install latest                               # SDK 4.33.1 (active)
SDK=~/.local/share/pebble-sdk/SDKs/4.33.1
~/.local/share/uv/tools/pebble-tool/bin/python -m venv --upgrade $SDK/.venv
(cd $SDK/.venv/bin && ln -sf python3.13 python && ln -sf python3.13 python3)
$SDK/.venv/bin/python -m pip install -r $SDK/sdk-core/requirements.txt
pebble sdk list
```

Step 3 is the route verified on the spark. Untried alternative: `rm -rf $SDK/.venv`, recreate it with `~/.local/share/uv/tools/pebble-tool/bin/python -m venv $SDK/.venv`, then the same `pip install -r`.

Gotchas:

- **`AssertionError: SRE module mismatch`** from `pebble build`: pebble-tool sets `PYTHONHOME` to the SDK's `.venv` and `PYTHONPATH` to its own `sys.path`, so the two venvs must be the same Python minor version. Repoint the SDK venv at 3.13 as in step 3.
- Reinstalling or upgrading pebble-tool drops the wheel; repeat step 2 afterwards.
- `STPyV8.JSContext().eval(...)` outside a `with` block segfaults. pypkjs uses it correctly; this only matters when poking at STPyV8 by hand.

The scaffold uses `@rebble/clay` (`pebble package install @rebble/clay`), not `pebble-clay` (1.0.4 does not declare newer platforms and the build fails).

## Emulator

The spark is headless, but no VNC or `xvfb-run` was needed: `pebble install --emulator` starts `qemu-pebble` without a display.

```bash
cd watch/app
pebble build
pebble install --emulator emery
pebble install --emulator emery --logs     # install and stream logs (console.log shows as xsHost.c lines)
pebble logs --emulator emery               # attach only; misses lines logged at launch
pebble screenshot --no-open --emulator emery /tmp/emery.png   # 200x228
pebble emu-button click select --emulator emery               # buttons: back, up, select, down
pebble kill                                                   # stop emulators
```

PKJS logs show as `pkjs>` lines in `pebble install --emulator emery --logs`. `pebble kill` can return before `qemu-pebble` has exited; check with `pgrep -fa qemu-pebble` before starting again.

Smoke test: Moddable's `hellopebble` example built, installed on emery, and logged `Hello, Pebble.`. The scaffold built for both platforms and installed on both emulators (default screen is a clock).

## Stub hub

`watch/app/dev/stub-hub.mjs` is a stand-in hub with canned data and no auth, speaking the query protocol (`shared/src/protocol.ts`, `WatchPending`) over HTTP and the `/api/watch/stream` WebSocket.

```bash
# from the repo root (ws resolves from the root node_modules)
node watch/app/dev/stub-hub.mjs --port 5173 [--scene default|all|empty|ring|many] [--dark 0|1] [--delay ms]
```

| Scene | What the watch gets |
| --- | --- |
| `default` | three sessions (waiting, running, done) and a pi query on the waiting one |
| `all` | the same plus a session in error |
| `empty` | no sessions, no queries |
| `ring` | the default plus a ring-profile query |
| `many` | twenty sessions with long titles and ~600-character replies; the phone sends twelve (its row limit), so an archived row is replaced by the next, as on the real hub (it lists up to 20 closed sessions) |

Live controls while it runs:

```bash
curl -s -XPOST localhost:5173/stub/notice -d '{"text":"Didn'"'"'t catch that"}'      # a notice frame
curl -s -XPOST localhost:5173/stub/query  -d '{"text":"Ship it?","options":["Yes","No"],"source":"ring-profile"}'
curl -s -XPOST localhost:5173/stub/dark   -d '{"dark":1}'                          # what /dev/settings reports (read at start)
curl -s -XPOST localhost:5173/stub/stream -d '{"count":240}'                        # run the open session (typing indicator, then the reply)
```

`/stub/stream` (`{sessionId?, ms?, count?}`, defaults: the session on screen, 250, 200) streams a reply the way the real hub does while pi runs (`hub/src/watch.ts`): the session goes to running, a `text` frame with the last 240 characters of a growing reply goes out every `ms`, a pending frame about once a second (the session's `updatedAt` moves), then a final frame and the session is done; its history then ends with the streamed reply. Open a session on the watch first.

**No live streaming.** The phone relays no streamed text (`streaming: true` frames) to the watch (spec §8a). While the open session's STATUS is `r`, the session screen keeps the last finished reply and three dots animate at the header's right end (`text.js` `Dots`: one Port, drawn with `fillColor`, ticking every 500 ms only while the window is up; a tick allocates nothing). When the session leaves running, the phone fetches the last agent turn from the history, as `open` does, and sends it once with the new status; a `streaming: false` frame that came during the run is the fallback if the history fails. Status changes otherwise still send the reply with the last text (`bridge.js` `update`). Over a 70 s stub run with the drawer and Home visited six times, the phone sent 10 reply dicts instead of one per streamed frame.

Dev loop (the emulator uses `http://127.0.0.1:5173` when no Hub URL is stored):

```bash
cd watch/app
pebble build
pebble install --emulator emery --logs          # pkjs> lines are the phone side
pebble screenshot --no-open --emulator emery /tmp/emery.png
pebble kill
```

## Watchapp

`watch/app/`. Watch side `src/embeddedjs/` (`main.js`, `theme.js`, `notice.js`, `modules/model.js`, `windows/`), phone side `src/pkjs/` (`index.js`, `bridge.js`, `config.js`). Screens are built from pebble-ui (menus, action menu, status bar); the Home screen, query/session views and the action-bar drawer live in `windows/`.

**Protocol.** Phone to watch is `MSG` dicts, watch to phone is `CMD` (string key; `CMD_ID` reserved). The tables are in `.superpowers/sdd/2026-10-27-watch-ui-rewrite/task-7-report.md` (plus the query `SESSION_ID` added in Task 9); the key names are `pebble.messageKeys` in `app/package.json`, and a test checks `main.js` `KEYS` against them in order. Add new keys to `package.json` first.

**Settings (Clay).** Hub URL and Dark theme. With no URL set the emulator uses `http://127.0.0.1:5173`; a real phone reports unconfigured until one is saved.

**Memory.** The VM runs with `stack 6144, slot 45056, chunk 21504` (`src/c/mdbl.c`, mirrored in `manifest.json`). The stack was raised from 5120 because Home's menu is built during the slide transition. The mod archive `build/mods/emery/mc.xsa` is 40,005 B.

**Styles stay in the chunk heap.** Piu keeps a style link and a computed Style for every Style instance a content has used, and frees them only in `application.purge()`, which pebble-ui's WindowStack calls after each slide. A screen rebuilt in place (a new reply or status, Home on each home dict) must not make new Styles or StatusBars each time: take styles from `theme.js` `style(font, color)` (one per font and colour) and change strings in place. Rebuilding the session window per streamed reply aborted with `Chunk allocation: 532 bytes failed` / `fxAbort memory full` after about eight replies (`.superpowers/sdd/2026-10-27-watch-ui-rewrite/stream-report.md`). During a slide both windows' screens are up and the heap is nearly full, so a dict that lands then must not allocate much: windows in history keep no screen data (Home drops its menu on leaving) and the text window compares fields instead of building a key string. A dict that lands during a slide is not applied until the slide ends (`main.js` `receive`, held in `onTransitionEnded`; home, reply, net and cfg dicts coalesce to the latest): popping back to Home builds its 12-row menu at the slide's start, and a home dict parsed then, with the text window still up, aborted with `Chunk allocation: 72 bytes failed`. The phone answers Archive with a home dict, so Archive hit it every time on a full list (`archive-typing-report.md`). Check with `/stub/stream`, with the drawer opened and Home visited mid-stream, and by archiving sessions in the `many` scene.

**Code size is memory (emulator).** The emulator copies the mod archive into RAM and at launch mallocs a table the size of the archive's `MAPS` atom. Too big and launch stops at `fxMapArchive failed` or `fxAbort memory full`. With the bigger stack the ceiling is about 42,000 B (it was about 42.8 KB with stack 5120; every KB of stack comes out of it). Measure after any change with `bash ../pebble-ui/tools/sizes.sh .` (in `watch/app`). On hardware the archive is mapped from flash, so the ceiling there is unknown until a Time 2 run. The pebble-ui skill (`using-pebble-ui`) lists the other memory errors ("Slot allocation", "stack overflow").

**Pacing.** The watch's `pebble/message` holds one unread dict, so the phone sends one at a time through the outbox in `src/pkjs/bridge.js` (coalescing and dropping repeats) and the watch applies a dict inside `onReadable` and rebuilds screens in one deferred pass.

### With the real hub

```bash
npm run dev -w hub      # one shell
npm run dev -w app      # another; serves on http://127.0.0.1:5173
```

Vite's `/api` proxy (with `ws: true`) adds the `Tailscale-User-Login` header the hub requires, as `tailscale serve` would, and `X-Forwarded-Host: localhost:5173`, so the dev hub's host check (`"hostname": "localhost:5173"` in `.dev-data/config.json`, see the root README) passes. On the spark the production hub listens on `127.0.0.1:7878` and its internal API on `127.0.0.1:7879` (`internalPort`), so give a dev hub other ports in `.dev-data/config.json` (for example `"port": 7880, "internalPort": 7881`) and start Vite with `PI_WEB_HUB=http://127.0.0.1:7880 npm run dev -w app`. For dialogs to reach the watch, add `"approvalMode": "manual"` there.

### Hub side

- **Internal API** (`hub/src/internal-server.ts`), loopback only, `127.0.0.1:7879` (config `internalPort`), for local services such as the ring profile: `GET /queries`; `POST /queries` with `{label, text, options[], callbackUrl, timeoutMs?}` raises an external query (the outcome is POSTed to `callbackUrl`); `POST /queries/:id/clear-by-ring` with `{text}`. Example: `curl -s -XPOST 127.0.0.1:7879/queries -d '{"label":"ring · follow-up","text":"test?","options":["A","B"],"callbackUrl":"http://127.0.0.1:9/x"}'`.
- **Queries** are held by `QueryStore` (`hub/src/queries.ts`). A voice note from the ring (agent webhook, `index-webhook.ts`) answers only the query on screen, else prompts the open session, else starts a new session; unmatched notes get the notices "Didn't catch that" / "Already answered".
- **Watch API:** `/api/watch/{answer,skip,showing,abort,archive,launch-target}` plus the stream and settings endpoints.
- **`watchAlert`** (hub config; `hub/src/notifier.ts`) decides how a closed watch app is alerted: `auto` (default behaviour: a Developer Connection BlobDB notification first, the PWA Web Push as fallback), `notification`, `push`, or `off`. One alert per event; push bodies carry the details.

### Pebble app setup (watchapp)

On the iPhone, in the Pebble app:

1. Install the app (`pebble install --phone <ip>` from `watch/app`, or the `.pbw` from `build/`). The phone's Developer Connection toggle is needed to install from the spark and for the hub's notification path.
2. **Notifications → pi-web → off** if the hub's `watchAlert` push would duplicate what the app shows.
3. Open the app's settings page (the gear next to pi-web in the Pebble app). Set **Hub URL** to the hub's tailnet URL, for example `https://<hostname>` (what `tailscale serve` publishes), and **Dark** as wanted. Save.

## Hardware checklist

For Michael's Pebble Time 2 and iPhone. Note the outcome of each item here.

- [ ] The build installs and launches; note the firmware's `Heap Usage for App` line at exit (`pebble logs`).
- [ ] The settings page saves Hub URL and Dark, and the theme switches without a relaunch.
- [ ] The socket connects; note whether the phone reports `ws online` or long-poll (the iOS PebbleKit JS may not offer `WebSocket`).
- [ ] Raise a query with the internal API (example above); answer it with buttons; skip it.
- [ ] A pi approval answered by ring; an unmatched ring note gives "Didn't catch that".
- [ ] App closed, raise a query: a notification or launch arrives (per `watchAlert`), once.
- [ ] Phone locked for 30 min with a session running, then unlocked: how long until the app is live again.
- [ ] Watch for lost AppMessages: a stale screen, or a failed answer that went through.
- [ ] Touch: tap a row to pick it (untested in the emulator).

## Known issues

- **Font.** The system `Gothic` font is used throughout (pebble-ui); LECO 1976 could not be licensed in.
- **Dictation is hardware only.** The emulator shows the dictation screen but cannot transcribe.
- **Touch is untested.** `pebble` has no touch injection.
- **Emulator code-size ceiling** is about 42,000 B (see Memory above).
- **Message loss is mitigated, not ruled out** (see Pacing above).
- **Native PKJS-ready message.** At launch the native module's PKJS-ready message reaches the phone as a dict with no `CMD`, and the phone logs `pi-web: unknown command ` (harmless).
