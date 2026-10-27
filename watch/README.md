# pi-web watch

Two Pebble Alloy projects (Moddable SDK on PebbleOS), both for emery (Pebble Time 2) and gabbro (Pebble Round 2):

- [The watchapp](#watchapp), `watch/app/` (see `app/CLAUDE.md`): the full UI for dialogs, finished turns, sessions, history and dictation.
- [The watchface](#watchface), `watch/face/` (see `face/CLAUDE.md`): the time and four corners, with a sheet that rises when a request is pending and opens the app on a wrist flick.

Both talk to the hub through a PebbleKit JS phone side. `watch/shared/` holds the modules they both use. The toolchain, emulator commands and stub hub below serve both; run `pebble` in `watch/app` or `watch/face`. `npm run test:watch` (`node --test watch/app/test/`) tests the app. `watch/face/` has been removed (the watch UI rewrite); the app builds on the `watch/pebble-ui` submodule: run `git submodule update --init` before `pebble build`.

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

The scaffold uses `@rebble/clay` (`pebble package install @rebble/clay`), not `pebble-clay`: `pebble-clay` 1.0.4 does not declare gabbro and the build fails with "doesn't support the 'gabbro' platform".

## Emulator

The spark is headless, but no VNC or `xvfb-run` was needed: `pebble install --emulator` starts `qemu-pebble` without a display.

```bash
cd watch/app
pebble build
pebble install --emulator emery            # or gabbro
pebble install --emulator emery --logs     # install and stream logs (console.log shows as xsHost.c lines)
pebble logs --emulator emery               # attach only; misses lines logged at launch
pebble screenshot --no-open --emulator emery /tmp/emery.png   # 200x228; gabbro is 260x260
pebble emu-button click select --emulator emery               # buttons: back, up, select, down
pebble kill                                                   # stop emulators
```

PKJS logs show as `pkjs>` lines in `pebble install --emulator emery --logs`. `pebble kill` can return before `qemu-pebble` has exited; check with `pgrep -fa qemu-pebble` before starting again.

Smoke test: Moddable's `hellopebble` example built, installed on emery, and logged `Hello, Pebble.`. The scaffold built for both platforms and installed on both emulators (default screen is a clock).

## Stub hub

Shared by the app and the face.

### The stub

`watch/app/dev/stub-hub.mjs` is a stand-in hub with canned data and no auth: three live sessions and twenty-three closed ones (so the sessions list pages), 40 history turns per session (some 240 characters), four models, and POSTs that answer `{ ok: true }`. On the `dialog` scene, an `answer` with dictated `text` answers `no_match` with the dialog's options; answered and dismissed requests leave the scene and a new `pending` frame goes out. History tool lines read `name · line` (`bash · npm test`), as the hub's `turnsFrom` writes them. `--delay <ms>` holds every POST's answer that long, to see the watch's `sending…` state. `GET /dev/settings` answers `{ "DARK": <--dark>, "CORNER_TL": "date", "CORNER_TR": "pi", "CORNER_BL": "hr", "CORNER_BR": "steps", "UNIT": "C", "LAUNCH_PORT": <port> }`, which the phone side (app and face) fetches at launch in the emulator so screenshots can switch theme; the app reads only `DARK`. `LAUNCH_PORT` is the emulator's phone simulator (pypkjs) port from `/tmp/pb-emulator.json` for `--platform` (default `emery`), or `0` when unreadable or with `--no-launch-port`. For the face, `GET /api/watch/weather` answers `{ "tempC": 11.5, "code": 3 }` and `POST /api/watch/launch` answers `{ ok: true }` (logged; nothing launches).

| Scene | What the watch gets |
| --- | --- |
| `dialog` (default) | a `bash` permission dialog on `notesky sync` (`allow`/`deny`) and a finished turn on `pi-web watch` |
| `finished` | the finished turn only |
| `empty` | nothing pending: home shows the current session's last reply |
| `stream` | nothing pending; on each socket open, `s1` runs and a `text` tail for it grows by a sentence every 250 ms for 6 s, then `streaming: false` and `s1` goes idle. As on the real hub, text frames go out only while the client's `showing` reports `s1` |

Two flags change any scene over time, counted from the first socket open (each change goes to open sockets as a fresh `pending` frame):

| Flag | What happens |
| --- | --- |
| `--after <ms>` | a second dialog, `dialog:s3:d2` on `llmwiki cron` (`edit`, `Allow edit?` / `wiki/index.md`), appears that long after the first socket open |
| `--resolve <ms>` | each request leaves that long after it appeared (the scene's own requests appear at the first socket open), so the face's counter drops and, when the last one leaves, its sheet slides away |

```bash
# from the repo root (ws resolves from the root node_modules)
node watch/app/dev/stub-hub.mjs --port 5173 [--scene dialog|finished|empty|stream] [--dark 0|1] [--delay ms] [--platform emery|gabbro] [--no-launch-port] [--corners date,pi,hr,steps] [--after ms] [--resolve ms]

# in another shell
cd watch/app
pebble build
pebble install --emulator emery --logs          # or gabbro; pkjs> lines are the phone side
pebble screenshot --no-open --emulator emery /tmp/emery.png
pebble kill
```

## Watchapp

`watch/app/`. Dev loop against the stub hub above, or the real hub below.

### In the emulator

In the emulator the phone side needs no settings: `Pebble.getActiveWatchInfo().model` starts with `qemu`, so with no stored hub URL it uses `http://127.0.0.1:5173`. On a real phone with no URL set it reports `NET: unconfigured` until one is saved in the Clay settings page (Hub URL and Dark).

**Transport in the emulator: `ws`.** The emulator's phone simulator (pypkjs) provides `WebSocket`, so the phone side streams from `/api/watch/stream` and logs `pi-web: ws online`. The long-poll fallback is not exercised there.

**What the `dialog` scene shows.** The watch sends `hello` on launch and the phone answers with `cfg`, `net` and `home`, then `stats`. The Home screen shows `PI-WEB 1/2` and the time, the toolbar for `notesky sync` (`CTX` bar, `18%`, `--` for speed, `QWEN3`), the query `bash: Allow bash?` / `git push origin main`, and the rows `allow` `deny` `say it` with `allow` selected. `pebble emu-button --emulator emery click down` then `click select` answers `deny`: the row shows `…`, then `sent` for a second (the stub logs `POST /api/watch/answer`), then the finished turn on `pi-web watch` (`PI-WEB 1/1`, rows `say it` `dismiss`). `click back` dismisses it (`POST /api/watch/dismiss`) and exits to the watchface. Hold Select (`push select`, wait, `release select`) opens the menu. Touch (tap a row to pick it) has no `pebble` command; it is untested in the emulator. Screenshots are in `watch/screenshots/`.

**What the `stream` scene shows.** The stream goes to `s1` (`pi-web watch`), so that session must be current. The emulator's phone remembers the current session across launches; if Home shows another one, pick `pi-web watch` under Menu → sessions, then relaunch. The query block then shows the end of the reply, growing a sentence at a time. The speed figure (`62 T/S`) blinks every 500 ms while `s1` runs. After 6 s the final tail stays as the last reply, the hint reads `PI-WEB WATCH · IDLE`, and the speed stops blinking. A later `home` with an older `lastText` does not replace it; only a change of current session does. No AppMessages were dropped with 240-character `TEXT` payloads.

**Say it in the emulator.** Picking `say it` opens the firmware's dictation screen (a pulsing dot), but the emulator cannot transcribe: after a press of Select it shows `Dictation is not available.` and the app logs `pi-web: dictation error 3`, then returns to the same rows. The transcript states (`sending…`, `sent`, `didn't match: allow, deny`) were checked with a temporary hook that fed a transcript in place of dictation (since removed): on the `dialog` scene the stub answers `no_match`, on `finished` and with nothing pending (a `prompt`) it answers ok. Run the stub with `--delay 5000` to see `sending…`.

**Pacing and lost messages.** The watch's `pebble/message` holds one unread dict; one that lands before the JS has read the previous is overwritten, and the firmware acks on receipt. Two mitigations, neither a guarantee:

- The phone sends one dict at a time (the outbox in `src/pkjs/bridge.js`: `home`, `stats` and `text` coalesce to the latest) and waits 100 ms after each ack before the next (`ACK_GAP_MS` in `src/pkjs/index.js`). The launch burst after `hello` (`cfg`, `net`, `home`, `stats`) goes through the same outbox. Without the gap, `net` and `stats` sent right after `cfg`/`home` were lost.
- The watch reads and applies a dict inside `onReadable` and returns at once; the screens update afterwards in one deferred pass for all the kinds that arrived meanwhile (`onMessage`/`onModelChanged` in `main.js`), so a slow screen rebuild does not hold the read callback.

The outbox also drops a `home`, `stats`, `text`, `net` or `cfg` identical to the last one queued of its kind, so a `home` lost after its retry is not resent until its content changes; the sequence-number and `hello` resync follow-up below covers that too.

A lost dict would show as a stale screen until the next frame, or, for a lost `result`, as `failed` after 10 s for an answer that went through. If that is seen on hardware, the fix is sequence numbers plus a `hello` resync.

**Memory.** The VM runs with `stack 5120, slot 43008, chunk 23552` (`src/c/mdbl.c`, mirrored in `manifest.json`). The words example's `slot 31744` aborts with `memory full` once the Home screen is built. Slot went from 40960 to 43008 for the menu screens: at 40960, picking a model aborted with `# Slot allocation: failed in fixed size heap` (every loaded screen module keeps its functions resident), and 41984 passed with under 1 KB to spare. The chunk heap went from 19456 to 23552 for the transcript screens. A Piu `Text` is chunk-heavy: the no_match screen (query, transcript, options) aborted with `# Chunk allocation … failed` at 19456. The app now uses no `Text` at all. AppMessage buffers are 1100 bytes in, 640 out (`watch/shared/js/link.js`), not the 8 KB default each. For the C heap figures of the final build, see the next paragraphs.

**Code size is memory (emulator).** The emulator copies the mod archive (`build/mods/<platform>/mc.xsa`) into RAM, and at launch the runtime mallocs a table the size of the archive's `MAPS` atom (2 bytes per identifier reference in the bytecode). Too big and launch stops at `fxMapArchive failed` or `fxAbort memory full`. Measured on emery: a 42.8 KB archive boots, 42.9 KB does not, so the ceiling is about 42.8 KB with the current VM sizes. Every byte of the archive copy is also a byte less C heap.

**The full build boots in both emulators.** The final archive is 42455 B (`MAPS` 5948 B), the same for emery and gabbro, about 340 B under the ceiling. The full build of Task 10 was 45702 B (`MAPS` 6496 B) and did not boot. The diet:

- Home's query block is whole lines of Labels (`wrapLines`/`tailLines`), not a Piu `Text`.
- The say-it and row feedback share one timer.
- The status line keeps its own clock.
- Skins and styles are made in `assets.js`.
- The words `Controller` is folded into `main.js`.
- The 12/24 h FFI call gave way to `watch.hour12`.
- `KEYS` is a single string.

Free heap with the full build on emery (temporary `heap_bytes_free()` probe, since removed, measured on a 42.3 KB build) was:

- 9.7 KB at `main.js`;
- 7.4 to 7.6 KB with Home built;
- 120.4 KB of 122.3 KB used at exit (the firmware's high-water mark).

The ceiling is about 42.8 KB; keep a working margin under 42.5 KB:

- Screens swap without transitions (`piuView.js`), and the Menu has no tweens.
- List screens share `modules/ListScreen.js`.
- Lists are virtualised: `Menu.js` keeps only the rows that fit plus one, re-bound on scroll.
- Sessions/models rows stay raw strings until drawn (`m.rowAt`).

On hardware the archive is mapped from flash, so the ceiling there is unknown until a Time 2 install.

Measure the build with `bash ../pebble-ui/tools/sizes.sh .` (in `watch/app`).

### With the real hub

```bash
npm run dev -w hub      # one shell
npm run dev -w app      # another; serves on http://127.0.0.1:5173
```

The emulator's default hub URL is `http://127.0.0.1:5173`, the same address; Vite's `/api` proxy (with `ws: true`) adds the `Tailscale-User-Login` header the hub requires, as `tailscale serve` would, and `X-Forwarded-Host: localhost:5173`, so the dev hub's host check (`"hostname": "localhost:5173"` in `.dev-data/config.json`, see the root README) passes although the emulator reaches Vite as `127.0.0.1:5173`. `/dev/settings` is stub-only; against the real hub that fetch fails quietly and the stored theme stays. To point at a hub on the tailnet instead, set the Hub URL in the settings page (`pebble emu-app-config --emulator emery`), for example `https://<hostname>`. The Hub URL must start with `http://` or `https://` (any case; trailing slashes are dropped); anything else counts as no URL (`NO HUB URL`).

On the spark the production hub already listens on `127.0.0.1:7878`, so give the dev hub another port in `.dev-data/config.json` (for example `"port": 7879`) and start Vite with `PI_WEB_HUB=http://127.0.0.1:7879 npm run dev -w app`. For dialogs to reach the watch, add `"approvalMode": "manual"` there.

Real hub: verified 2026-10-17 on emery (dev hub on 7879 with `approvalMode: manual`, Vite on 5173). Before the `X-Forwarded-Host` stamp every watch request and the socket upgrade were rejected (`rejected GET /api/watch/pending: host 127.0.0.1:5173`); with it the pkjs log reached `pi-web: ws online` and Home showed `PI-WEB 0/0` with the newest closed session's last reply. A session created through Vite (`POST /api/sessions`, then a `prompt` command asking for `echo hello-from-watch > out.txt`) raised the pi-permission-system dialog (`bash: Permission Required`, four options `Yes`, `Yes, allow bash "echo *" for this session`, `No`, `No, provide reason`, with `PI-WEB 1/1` and a live `T/S`). Select on `Yes` sent the answer (`send result`), the command ran (`out.txt` held `hello-from-watch`), and Home moved to the finished turn (``Done. `out.txt` now contains `hello-from-watch`.``, rows `say it` `dismiss`); Back dismissed it.

### Pebble app setup (watchapp)

On the iPhone, in the Pebble app:

1. Install the app (`pebble install --phone <ip>` from `watch/app`, or the `.pbw` from `build/`). The phone's Developer Connection toggle is only for installing from the spark; the app itself does not need it.
2. **Notifications → pi-web → off**, so pi-web's push notifications do not duplicate what the app shows.
3. Open the app's settings page (the gear next to pi-web in the Pebble app). Set **Hub URL** to the hub's tailnet URL, for example `https://<hostname>` (what `tailscale serve` publishes), and **Dark** as wanted (default on). Save. Enter the Hub URL in the face's settings page too (see Watchface). With no URL the status line reads `NO HUB URL`.

The status line's left text is the connection cue: `CONNECTING` until the phone reaches the hub, `OFFLINE` while it cannot, `NO HUB URL` with nothing set, and `PI-WEB n/m` otherwise.

## Watchface

`watch/face/`. An Alloy watchface (`watchface: true`) for emery and gabbro; `face/CLAUDE.md` has the code layout. Same toolchain and commands as the app, run in `watch/face`:

```bash
node watch/app/dev/stub-hub.mjs --port 5173 --scene empty     # from the repo root
cd watch/face && pebble build && pebble install --emulator emery --logs
```

### What it shows

The time, in the middle, and four corners. Each corner is one of `date`, `pi` (the hub's `running/pending` counts, doubling as the connection cue), `hr`, `steps`, `battery`, `weather` or `none`; the defaults are date, `pi`, heart rate, steps. A pending hub request raises a sheet over the bottom of the screen (see The sheet), the phone buzzes the watch for each new request, and a wrist flick with the sheet up opens the watchapp (see Launch paths).

### Settings (Clay)

The face's own settings page, in the Pebble app: **Hub URL**, the four corners, **Dark**, and the temperature unit (`C` or `F`). Corners, dark and unit apply without a relaunch.

**Hub URL: enter it in both apps.** PebbleKit JS `localStorage` is per app on a real phone, so the face cannot read the watchapp's stored URL (or the reverse) even though both use the key `pi-web.hubUrl`: the key names coincide, the storage does not. Set the URL on the face's page and on the app's page (spec §12: entered twice in v1). The Hub URL must start with `http://` or `https://`; anything else counts as no URL.

### Stub scenes, flags and `/dev/settings`

The stub is described above (scenes `dialog`, `finished`, `empty`, `stream`; `--after`, `--resolve`, `--corners`, `--dark`, `--no-launch-port`). For the face, `GET /dev/settings` answers `DARK`, `CORNER_TL`, `CORNER_TR`, `CORNER_BL`, `CORNER_BR`, `UNIT` (`C`) and `LAUNCH_PORT`, which the phone side fetches at launch in the emulator; the stub also answers `GET /api/watch/weather` and `POST /api/watch/launch`.

### Emulator commands

All take `--emulator emery` (or `gabbro`):

| Command | Use |
| --- | --- |
| `pebble emu-battery --percent 80` | battery corner |
| `pebble emu-heart-rate 72` | heart-rate corner |
| `pebble emu-steps 4210` | steps corner |
| `pebble emu-tap --direction x+` | the flick |
| `pebble emu-app-config` | opens the Clay page in a browser; the headless spark has none, so use the stub's `/dev/settings` with `--corners` and `--dark` instead (see Testing the Clay page) |

### Launch paths

The flick has three ways to open the watchapp; the phone tries them in order and logs which one worked. The launch itself is the same on all of them: one 22-byte binary frame, `01 | 00 11 | 00 34 | 01 | <16 UUID bytes>` (RelayToWatch, Pebble Protocol length 0x0011 = 17, endpoint 0x0034 AppRunState, command 0x01 start, then the app's uuid). `launchFrame` in `hub/src/watch-launch.ts` and `watch/face/src/pkjs/launch.js` build the same bytes.

1. **Loopback** (`pi-web: launch via loopback`). The phone connects to its own Developer Connection at `ws://127.0.0.1:9000/` and sends the frame. Needs the toggle on: in the Pebble app, Settings, the watch, Developer Connection, on. Port 9000. In the emulator the phone simulator's port is `pypkjs.port` in `/tmp/pb-emulator.json`, which the stub serves as `LAUNCH_PORT` (`--no-launch-port` makes it `0` and skips this path).
2. **Via the hub** (`pi-web: launch via hub`). `POST /api/watch/launch { uuid }`; the hub opens `ws://<phone>:9000/` over the tailnet and sends the same frame. It targets the first entry of the last `X-Forwarded-For` it saw on a watch request (see [Launch in docs/watch-api.md](../docs/watch-api.md#launch)). Also needs the toggle. Path 1 on iOS is unverified until hardware: iOS may not let PebbleKit JS reach its own port 9000, which is what path 2 is for.
3. **Manual**: assign the watchapp to Quick Launch on the watch.

A tap sets the footer to `opening…` for 3 s. If neither path works the phone answers with a failure, which turns the footer back when it arrives; with the loopback's 2.5 s timeout and a hub POST after it, that is usually after the 3 s are up, so the footer has already reverted. Further taps are ignored until the launch is answered (or the sheet falls, or at most 20 s).

### Idle policy

With nothing pending and no session running for 10 quiet minutes, the phone closes the socket and polls `GET /api/watch/pending` once a minute (the watch's `NET` reads `idle`; a failed poll sets it to `offline`, so the `pi` corner reads `OFF`, and the next quiet poll sets it back to `idle`). The first poll that sees a request or a running session reopens the socket. So the first new request after going idle can be up to 60 s late. Unit-tested only; not soaked in the emulator.

### Details

On `--scene empty` the face shows the time, `SAT 17` top left, `1/0` top right (`s1` is running, nothing pending), and heart rate and steps at the bottom once the emulator has values: `pebble emu-heart-rate 72`, `pebble emu-steps 4210`, `pebble emu-battery --percent 80` (all with `--emulator emery`). `pi` reads `--` until the phone's first `pending` frame. Screenshots: `screenshots/face-idle-{emery,gabbro}-{dark,light}.png` (light with stub `--dark 0`). On gabbro the heart rate stayed `--` after `emu-heart-rate 72`; emery shows `72`.

**The `pi` corner is the connection cue** (spec §6.1: the face has no status line). While the phone reports `NET` `offline` or `unconfigured` the corner reads `OFF`; `idle` (the phone polling once a minute) and `connecting` keep the last counts. Unit-tested only: in the emulator pypkjs fires no `onclose` on a socket whose hub dies or refuses the connection, so the phone stays `connecting` and the corner keeps its counts (or `--` before the first frame).

**The sheet** (spec §6.2; `src/embeddedjs/sheet.js`). A pending request raises an 84 px sheet over the bottom of the screen: a 2 px rule, the eyebrow (`PI-WEB · BASH`, or `DONE`, `ERROR`, `QUESTION`), the message in a two-line clip, and the footer `FLICK TO OPEN` / `1 OF 2`. The rise is one Piu `Timeline`, 350 ms, quad ease-out: the idle group's height shrinks to the space above the sheet (its labels re-lay out from `layout()` on every step) while the sheet slides up; the fall plays it backwards and removes the sheet. A `sheet` dict while the sheet is up only changes its texts. A message longer than two lines scrolls a line at a time: 2 s at the top, a line every 1.5 s, 2 s at the end, then back to the top (a horizontal marquee of a 240-character message is unreadable, and the clip already wraps). The phone decides the vibe (`VIBE: 1` when a request id appears that the previous frame did not have; not on a switch to the next oldest, a counter change, a replayed list, or the first frame after launch); the watch logs `pi-web: vibe` and calls `Vibes.shortPulse()` (the emulator has no vibration).

- On `--scene dialog` the sheet is up at launch: `PI-WEB · BASH`, `Allow bash?` / `git push origin main`, `FLICK TO OPEN` `1 OF 2`; the time and corners sit above the rule. On `--scene empty --after 5000` the face idles, then logs `pi-web: vibe` and the sheet rises with `PI-WEB · EDIT`. With `--after 5000 --resolve 10000` (default scene) the counter reads `1 OF 3` after the vibe, `1 OF 1` once the first two leave, and the sheet slides away when the last does. On `--scene finished` the four-line message scrolls. Screenshots: `screenshots/face-sheet-{emery,gabbro}-{dark,light}.png`, `face-sheet-long-emery-dark.png`, `face-opening-emery-dark.png` (the footer after a flick: stub `--no-launch-port`, `emu-tap`, screenshot within 3 s).
- **Gabbro (Round 2).** The sheet is the bottom 84 px segment of the 260 px circle (rule at y 176). Its chord is about 226 px under the rule, about 160 px at the second message line and under 50 px at the bottom, so emery's rows (18 + 2 x 22 + 18, footer to y 258) put the footer in the rim. On gabbro the rows are 16 + 2 x 20 + 16 (footer glyphs end near y 247), the counter rides in the eyebrow (`PI-WEB · BASH · 1 OF 2`, centred), the footer is `FLICK TO OPEN` or `opening…` alone, centred, and the message wraps to 148 px (56 px inset; a full line keeps about 4 px off the rim at the second line's baseline). The closest ink to the rim in the gabbro captures is 6.7 px (message) and 8.5 px (footer). The idle screen's `layout()` is unchanged. Emery's sheet is unchanged.
- **Piu has no `top` accessor.** `Timeline.to(content, { top })` writes a plain JS property and nothing moves; the sheet's tween is on `y` (the application is at 0, so `y` is the top). The idle group's `height` works because its height is declared (`top: 0, height: screen.height`).
- **One log reader.** Two `pebble install --logs` left attached to the same emulator print every line twice (or three times): stop the old one before reading counts such as `pi-web: vibe` from the log.
- **Archive size.** `face/build/mods/emery/mc.xsa` (and gabbro's) is 22438 B with the flick held until its result or 20 s (22198 B with the Round 2 sheet and the net cue, 21942 B with the flick, 20583 B with the sheet, 14876 B before it), far under the 42.8 KB ceiling. The VM sizes are the app's.
- **Memory.** Soaked 2026-10-17 on emery for 14.5 minutes: three runs of the stub with `--scene dialog --after 5000 --resolve 15000 --no-launch-port` (rise, vibe, `1 OF 3`, a flick, the counter drops, the fall; the face reinstalled for each run because pypkjs never notices the stub going away), then one face kept up for 4 minutes on `--scene finished` (the long message scrolling, the accelerometer open, a flick). No `memory full`, `Slot allocation`, `Chunk allocation` or crash line in `pebble logs` or the serial log. Every exit logged `Heap Usage for App <pi-web fac: Total Size <122568B> Used <96308B> Still allocated <0B>` (96.3 KB of 122.6 KB, about 26 KB to spare), the same after the 4-minute run. The only firmware complaint is `accel_service.c:441> Not enough memory to subscribe` at each sensor open (see The flick).
- **The flick** (spec §6.3, §8; `src/pkjs/launch.js`). While a sheet is up or rising the face holds `new Accelerometer({ onTap })` (`embedded:sensor/Accelerometer`, only one per process); it is closed when the sheet starts to fall and in `onUndisplaying`, so with no sheet a tap does nothing. A tap logs `pi-web: flick`, sets the footer to `opening…`, sends `CMD launch` and arms a 3 s timer that restores `FLICK TO OPEN`; taps are ignored while it runs and until the launch's `result` arrives (or the sheet falls, or 20 s pass: the phone's 2.5 s loopback plus its 15 s hub POST, rounded up, so a lost `result` does not lock the flick out), so a second tap cannot start a second launch mid-POST. The phone tries the Developer Connection on `ws://127.0.0.1:9000/` (one 22-byte binary frame, `0100110034016d55f4ea2ff6419ea2be1ebdfd4f8f0b`: RelayToWatch, length 17, endpoint 0x0034 AppRunState, START, the app uuid; the hub's `launchFrame` makes the same bytes), then `POST /api/watch/launch { uuid }`, logs `pi-web: launch via loopback|hub` or `pi-web: launch failed`, and answers with a `result` dict (`OK 1`/`0`, FIFO in the outbox). The watch logs `pi-web: launch ok|failed`; `OK 0` restores the footer when it arrives (usually after the timer already has), `OK 1` leaves `opening…` until the timer (the app takes the screen). In the emulator the loopback port is `LAUNCH_PORT` from `/dev/settings` (pypkjs speaks the same relay protocol; `0`, i.e. `--no-launch-port`, skips the loopback). `pebble emu-tap --emulator emery --direction x+` is the flick.
  - Verified 2026-10-17 on emery with the app installed: loopback: `pi-web: flick`, `pi-web: launch via loopback`, `send result`, `pi-web: launch ok` (pypkjs accepts `send(ArrayBuffer)` and relays it). With `--no-launch-port`: `launch via hub`, the stub logs `launch 6d55f4ea-… (stub: nothing launches)`, the footer reads `opening…` and reverts after 3 s. A hub answering `{ ok: false }`: `pi-web: launch failed` on both sides and the footer reverts at once. A second tap while opening sends nothing; a tap with no sheet logs nothing. The firmware logs `accel_service.c:441> Not enough memory to subscribe` when the sensor opens (the sample stream, which the face does not use); taps still arrive.
  - **The emulator does not open the app from this face.** The relayed AppRunState START reaches the firmware, which force-kills the front app (the SDK shell's phone-launch path) and here counts that as a watchface crash: the serial log shows `Watchface crashed (id=1); relaunching`, the watch reports face stop, launcher start/stop, face start, and the app never starts (twice in 30 s gives `reverting to default` and `pi-web face is not responding`). The same bytes launch the app from the launcher or from TicToc, and `pebble install` of the app with the face in front hits the same crash. The stock Alloy example `hellowatchface` (Moddable-OpenSource/pebble-examples, a Poco clock with no sensors, timers or messages) does the same on `pebble install` of the app over it: `Watchface crashed (id=3); relaunching`, then `Hello, Watchface.` again. Installing our face over the stock one does the same (the stock face is relaunched and stays in front). Leaving either face for the launcher (Select) exits cleanly with `Heap Usage for App`, and so does `pebble install` of the face over itself. So it is any Alloy face under the forced kill, not the flick code or a resource the face holds; nothing to fix in the face. Whether real hardware's normal shell closes an Alloy face cleanly is unknown; see the hardware checklist.
  - pypkjs's `XMLHttpRequest` never calls `onerror` on a refused connection (it fires only `loadend`), so with the hub down the hub path never answers in the emulator and the footer reverts on the 3 s timer.
- **The phone speaks first.** The watch's `pebble/message` can write only after it has received a dict (`pkjsReady` is set in `messageReceived`, `pebble-appmessage.c`), so the face's phone side sends `cfg`, `net`, `pi`, `sheet` on `ready`, and again when the watch's `hello` arrives, as the app's bridge does. Waiting for `hello` first deadlocks.
- **Hub URL, twice.** PebbleKit JS `localStorage` is per app on a phone, so the face cannot read the app's stored hub URL even though both use the key `pi-web.hubUrl`. Set **Hub URL** in the face's settings page too (spec §12: entered twice in v1).
- **Corner readings.** Steps come from `Health.metric.get("step count")` on `minutechange` and on `health` events; in QEMU the live value stays 0, so the face falls back to the day's sum (`Health.metric.query`, since local midnight), which `emu-steps` does set. Heart rate and steps show `--` when 0, battery is `Battery.sample().percent`. Weather is phone-side (`src/pkjs/weather.js`): position, then `GET /api/watch/weather?lat=&lon=` every 20 minutes, sent as the `weather` dict. The reading and its time are kept in `localStorage` (`pi-web.weather`): the face's JS restarts after every visit to the app, and a reading under 20 minutes old is shown at once with no fetch until it turns 20 minutes old; a failed position forgets it; `12°` in the emulator from the stub. The stub's `--corners weather,battery,hr,steps` reassigns the corners.
- **Testing the Clay page.** `pebble emu-app-config` opens a browser, which the headless machine does not have. The page's effect is the settings dict the phone applies, and the stub serves that at `/dev/settings` (`--dark`, `--corners`; `UNIT` is `C`), so restart the stub with other flags and reinstall to test corner assignment and theme.
- **Font strings.** Piu font strings are CSS-like: `"bold 18px Gothic"`. `"18px bold Gothic"` looks for `boldGothic-Regular-18.fnt` and the face fails to load (the firmware then shows `face is not responding`).
- **A wedged emulator.** Twice during the face work the emery emulator stopped answering (`pebble screenshot` and `install` time out with `libpebble2.exceptions.TimeoutError`), and after killing it the firmware no longer booted (`Waiting for the firmware to boot.` forever). Moving the persisted flash aside (`~/.local/share/pebble-sdk/4.33.1/emery/qemu_spi_flash.bin`) gave a clean boot; the face then ran for several minutes without trouble.

## Hardware checklist

For Michael's Pebble Time 2 and iPhone. Note the outcome of each item here.

- [ ] The full build installs and launches on the Time 2. The emulator copies the archive into RAM; hardware maps it from flash. Note the firmware's `Heap Usage for App` line at exit (`pebble logs`); in the emulator it was 120.4 KB of 122.3 KB.
- [ ] The settings page opens from the Pebble app, saves Hub URL and Dark, and the theme switches on the watch without a relaunch.
- [ ] The socket connects. Note which transport the phone reports: `pi-web: ws online`, or long-poll in `pebble logs`. The iOS PebbleKit JS may not offer `WebSocket`.
- [ ] Lock the phone for 30 min with a session running, then unlock it and open the app. Note how long the status line takes to go from `OFFLINE`/`CONNECTING` back to `PI-WEB n/m`.
- [ ] Dictation round trip. `say it` → speak → the firmware's confirm screen → `sending…` → `sent`, with the prompt arriving in the session. On a select dialog, saying something that matches no option gives `didn't match: …` and the options come back.
- [ ] Answer a real dialog with a button (`…`, then `sent`), and watch a reply stream live into the home screen. The speed figure should blink while the session runs and stop when it ends.
- [ ] Back on a request dismisses it and exits to the watchface; Back with nothing pending just exits.
- [ ] Watch for lost AppMessages: a screen that stays stale, or `failed` after 10 s for an answer that did go through (a lost `result`). If seen, add sequence numbers and a `hello` resync (see Pacing above).
- [ ] Touch: tap a row to pick it (untested in the emulator).
- [ ] Flick from the face with a sheet up: with the Developer Connection on (Pebble app settings), the pkjs log shows `pi-web: launch via loopback` and the app opens (in the emulator the forced kill of the face counts as a crash and the app never opens, see The flick). With it off, `launch via hub` (needs the hub's phone address). Note whether the tap fires on a deliberate wrist flick and not on normal arm movement.
- [ ] An app launched over the face (the flick, or `pebble install --phone <ip>` of the app with the face in front) closes the face cleanly: `pebble logs` shows `Heap Usage for App` for the face and no `Watchface crashed`. In the emulator every Alloy face, the stock `hellowatchface` included, logs `Watchface crashed … relaunching` there (see The flick).
- [ ] A dialog with long or non-ASCII options shows on the watch (the phone trims the request text and clips options to fit the 1000-byte budget), and picking a clipped option answers it.

Watchface items:

- [ ] The face installs and runs on the Time 2; note `Heap Usage for App` at exit (emulator: 96308 of 122568 B).
- [ ] The face's Clay page saves corners, dark, hub URL and unit; corners change without a relaunch. The Hub URL is entered here as well as on the app's page.
- [ ] Heart rate and steps read live; battery and date are correct; weather appears within a minute of launch (needs the location permission for the Pebble app).
- [ ] A dialog raised on the hub makes the face vibe and the sheet rise; the counter follows a second dialog; answering from the phone app drops it.
- [ ] **Flick, which path:** `pi-web: launch via loopback` (Developer Connection toggle on), `via hub` (with the hub seeing the phone's tailnet IP in `X-Forwarded-For`), or neither, so Quick Launch is the manual path. Note whether the toggle survives a Pebble app restart.
- [ ] Phone locked in a pocket for 30 minutes with a session running: does the sheet appear for a dialog raised meanwhile, and how late? Then the same with the face idle (nothing running for 10 minutes): how long from the dialog to the sheet?
- [ ] `pi-web` muted in the Pebble app's notifications: no double delivery.
- [ ] Watch for lost `sheet` dicts: a sheet that stays after its request was answered, or a request on the hub with no sheet (and no vibe). Note how often, and whether the 5-minute resend repairs it.
- [ ] An Index 01 recording with the sheet up answers that request; one with nothing pending starts a session in `~/pebble/` and its finished turn reaches the sheet.

## Known issues

### Watchapp

- **Font.** The LECO 1976 font could not be fetched (fontlibrary.org serves no download for it), so the UI uses the system `Gothic` font (`makeTheme` in `app/src/embeddedjs/assets.js`). Dropping a licensed TTF into `app/src/embeddedjs/assets/fonts/` and adding a `resources` entry in the manifest would restore it.
- **Dictation is hardware only.** The emulator shows the dictation screen but cannot transcribe (error 2 or 3, then back to the rows). The transcript states were checked with a temporary hook.
- **Touch is untested.** `pebble` has no touch injection.
- **Emulator code-size ceiling.** The full build boots, with about 340 B to spare (ceiling about 42.8 KB; keep a working margin under 42.5 KB) (see Code size is memory above). Past the ceiling, use `dev/build-subset.mjs`.
- **Message loss is mitigated, not ruled out** (see Pacing above).
- **Alloy faces crash when an app launches over them (emulator).** The firmware counts the forced kill of any Alloy watchface as a crash (`Watchface crashed (id=n); relaunching`; twice in about 30 s reverts to the default face and shows `<face> is not responding`), so the flick never opens the app in the emulator. The stock `hellowatchface` example does the same; unverified on hardware (see the hardware checklist).
- **Native PKJS-ready message.** At launch the native module's PKJS-ready message reaches the phone as a dict with no `CMD`, and the phone logs `pi-web: unknown command ` (harmless). The watch's first `hello` write can fail there with `output_begin failed`; it is retried.
- **Stats switch early.** After an answer the phone switches `stats` to the next session at once, so for about a second the toolbar can show the next session's figures under the answered request.
- **History.** A theme change on History reloads the newest page and loses the scroll position. A failed page shows `/-1` in the status until the next Up retries it. There is no touch drag.
- **Round 2 rim.** The rim cuts the first and last characters of a full-width history line at the very top and bottom of the view, and the free-centred Sessions list leaves paper above its first row.
- **A lost `list` dict on History** leaves the page marked as loading until Back: Down does nothing, and Up scrolls but loads no older turns.
- **Menu selection.** Coming back to the Menu from a screen starts the selection on `sessions` again.
- **Models on a closed session.** ModelView shows an empty screen when the models fetch fails; for a closed current session it always fails (the hub answers 404).
- **History cap.** History keeps at most 24 turns; scrolling back past that drops the newest turns from the window. Back and reopen History to see them again.
- **Last reply after relaunch.** The fetched last reply is the hub's history text, clipped by the hub to its first 240 characters; Home shows the end of that, so after a relaunch a long reply shows its middle where streaming showed its real end.
- **`showing` outlives the app.** The phone does not clear `showing` when the watch app exits, so the hub keeps sending that session's speed ticks and text until the face's phone side reports its own sheet (`showing(null, null)` with nothing pending) on its first frame after every socket open, or until the app's socket closes.
- **Sessions list is a snapshot.** The Sessions list does not refresh in place while open; Back and reopen it for new state.

### Face known issues

- **Fonts.** System `Gothic` only: the corners are Gothic Bold 18 until the LECO 1976 file can be licensed in (see the app's Font note).
- **Emulator health values** are whatever `emu-heart-rate`/`emu-steps`/`emu-battery` set. QEMU's `Health.metric.get("step count")` stays 0, so steps fall back to the day's `query` sum. On gabbro the heart-rate corner stayed `--` after `emu-heart-rate` (uninvestigated); emery shows the value.
- **Geolocation in the emulator** comes from pypkjs's `navigator`, not a real fix, so weather there is the stub's canned `12°`.
- **Path 1 on iOS unverified** until hardware (see Launch paths).
- **The `OFF` cue cannot be seen in the emulator**: pypkjs fires no `onclose` on a dead socket, and its `XMLHttpRequest` never errors on a refused connection.
- **Alloy teardown crash.** The firmware kills any Alloy face when another app launches over it and counts it as `Watchface crashed`, the stock `hellowatchface` included; the flick never opens the app in the emulator (see The flick).
- **Idle latency.** Up to 60 s for the first request after going idle (see Idle policy).
- **A lost `sheet` dict is resent only after 5 minutes.** The watch acks a dict on receipt even when its one unread slot was overwritten (see Pacing), and the phone sends only changes, so a lost hide leaves the sheet up (and the accelerometer open) over an answered request, and a lost new sheet never shows or vibes. The phone sends the current sheet again with the first frame after it has been unchanged for 5 minutes (the watch ignores an identical one); no sequence numbers.
