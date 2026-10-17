# pi-web watch app

Pebble watchapp built with Alloy (Moddable SDK on PebbleOS). Targets emery (Pebble Time 2) and gabbro (Pebble Round 2).

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

## Dev loop

### With the stub hub

`watch/app/dev/stub-hub.mjs` is a stand-in hub with canned data and no auth: three live sessions and twenty-three closed ones (so the sessions list pages), 40 history turns per session (some 240 characters), four models, and POSTs that answer `{ ok: true }`. On the `dialog` scene, an `answer` with dictated `text` answers `no_match` with the dialog's options; answered and dismissed requests leave the scene and a new `pending` frame goes out. History tool lines read `name · line` (`bash · npm test`), as the hub's `turnsFrom` writes them. `--delay <ms>` holds every POST's answer that long, to see the watch's `sending…` state. `GET /dev/settings` answers `{ "DARK": <--dark> }`, which the phone side fetches at launch in the emulator so screenshots can switch theme.

| Scene | What the watch gets |
| --- | --- |
| `dialog` (default) | a `bash` permission dialog on `notesky sync` (`allow`/`deny`) and a finished turn on `pi-web watch` |
| `finished` | the finished turn only |
| `empty` | nothing pending: home shows the current session's last reply |
| `stream` | nothing pending; on each socket open, `s1` runs and a `text` tail for it grows by a sentence every 250 ms for 6 s, then `streaming: false` and `s1` goes idle. As on the real hub, text frames go out only while the client's `showing` reports `s1` |

```bash
# from the repo root (ws resolves from the root node_modules)
node watch/app/dev/stub-hub.mjs --port 5173 [--scene dialog|finished|empty|stream] [--dark 0|1] [--delay ms]

# in another shell
cd watch/app
pebble build
pebble install --emulator emery --logs          # or gabbro; pkjs> lines are the phone side
pebble screenshot --no-open --emulator emery /tmp/emery.png
pebble kill
```

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

**Memory.** The VM runs with `stack 5120, slot 43008, chunk 23552` (`src/c/mdbl.c`, mirrored in `manifest.json`). The words example's `slot 31744` aborts with `memory full` once the Home screen is built. Slot went from 40960 to 43008 for the menu screens: at 40960, picking a model aborted with `# Slot allocation: failed in fixed size heap` (every loaded screen module keeps its functions resident), and 41984 passed with under 1 KB to spare. The chunk heap went from 19456 to 23552 for the transcript screens. A Piu `Text` is chunk-heavy: the no_match screen (query, transcript, options) aborted with `# Chunk allocation … failed` at 19456. The app now uses no `Text` at all. AppMessage buffers are 1100 bytes in, 640 out (`modules/link.js`), not the 8 KB default each. For the C heap figures of the final build, see the next paragraphs.

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

When a change pushes the full build over the ceiling, check a screen with a subset of the views:

```bash
cd watch/app
node dev/build-subset.mjs MenuView History    # Home is always in; then pebble install as usual
```

`dev/build-subset.mjs` writes a temporary manifest that lists only the named views, then runs `pebble build`. It restores the real manifest afterwards, also on failure; never commit the temporary one. It removes `build/mods` before and after, so the next full `pebble build` relinks. Opening a screen that was left out aborts the app.

### With the real hub

```bash
npm run dev -w hub      # one shell
npm run dev -w app      # another; serves on http://127.0.0.1:5173
```

The emulator's default hub URL is `http://127.0.0.1:5173`, the same address; Vite's `/api` proxy (with `ws: true`) adds the `Tailscale-User-Login` header the hub requires, as `tailscale serve` would, and `X-Forwarded-Host: localhost:5173`, so the dev hub's host check (`"hostname": "localhost:5173"` in `.dev-data/config.json`, see the root README) passes although the emulator reaches Vite as `127.0.0.1:5173`. `/dev/settings` is stub-only; against the real hub that fetch fails quietly and the stored theme stays. To point at a hub on the tailnet instead, set the Hub URL in the settings page (`pebble emu-app-config --emulator emery`), for example `https://<hostname>`. The Hub URL must start with `http://` or `https://` (any case; trailing slashes are dropped); anything else counts as no URL (`NO HUB URL`).

On the spark the production hub already listens on `127.0.0.1:7878`, so give the dev hub another port in `.dev-data/config.json` (for example `"port": 7879`) and start Vite with `PI_WEB_HUB=http://127.0.0.1:7879 npm run dev -w app`. For dialogs to reach the watch, add `"approvalMode": "manual"` there.

Real hub: verified 2026-10-17 on emery (dev hub on 7879 with `approvalMode: manual`, Vite on 5173). Before the `X-Forwarded-Host` stamp every watch request and the socket upgrade were rejected (`rejected GET /api/watch/pending: host 127.0.0.1:5173`); with it the pkjs log reached `pi-web: ws online` and Home showed `PI-WEB 0/0` with the newest closed session's last reply. A session created through Vite (`POST /api/sessions`, then a `prompt` command asking for `echo hello-from-watch > out.txt`) raised the pi-permission-system dialog (`bash: Permission Required`, four options `Yes`, `Yes, allow bash "echo *" for this session`, `No`, `No, provide reason`, with `PI-WEB 1/1` and a live `T/S`). Select on `Yes` sent the answer (`send result`), the command ran (`out.txt` held `hello-from-watch`), and Home moved to the finished turn (``Done. `out.txt` now contains `hello-from-watch`.``, rows `say it` `dismiss`); Back dismissed it.

## Pebble app setup

On the iPhone, in the Pebble app:

1. Install the app (`pebble install --phone <ip>` from `watch/app`, or the `.pbw` from `build/`). The phone's Developer Connection toggle is only for installing from the spark; the app itself does not need it.
2. **Notifications → pi-web → off**, so pi-web's push notifications do not duplicate what the app shows.
3. Open the app's settings page (the gear next to pi-web in the Pebble app). Set **Hub URL** to the hub's tailnet URL, for example `https://<hostname>` (what `tailscale serve` publishes), and **Dark** as wanted (default on). Save. With no URL the status line reads `NO HUB URL`.

The status line's left text is the connection cue: `CONNECTING` until the phone reaches the hub, `OFFLINE` while it cannot, `NO HUB URL` with nothing set, and `PI-WEB n/m` otherwise.

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
- [ ] A dialog with long or non-ASCII options shows on the watch (the phone trims the request text and clips options to fit the 1000-byte budget), and picking a clipped option answers it.

## Known issues

- **Font.** The LECO 1976 font could not be fetched (fontlibrary.org serves no download for it), so the UI uses the system `Gothic` font (`makeTheme` in `app/src/embeddedjs/assets.js`). Dropping a licensed TTF into `app/src/embeddedjs/assets/fonts/` and adding a `resources` entry in the manifest would restore it.
- **Dictation is hardware only.** The emulator shows the dictation screen but cannot transcribe (error 2 or 3, then back to the rows). The transcript states were checked with a temporary hook.
- **Touch is untested.** `pebble` has no touch injection.
- **Emulator code-size ceiling.** The full build boots, with about 340 B to spare (ceiling about 42.8 KB; keep a working margin under 42.5 KB) (see Code size is memory above). Past the ceiling, use `dev/build-subset.mjs`.
- **Message loss is mitigated, not ruled out** (see Pacing above).
- **Native PKJS-ready message.** At launch the native module's PKJS-ready message reaches the phone as a dict with no `CMD`, and the phone logs `pi-web: unknown command ` (harmless). The watch's first `hello` write can fail there with `output_begin failed`; it is retried.
- **Stats switch early.** After an answer the phone switches `stats` to the next session at once, so for about a second the toolbar can show the next session's figures under the answered request.
- **History.** A theme change on History reloads the newest page and loses the scroll position. A failed page shows `/-1` in the status until the next Up retries it. There is no touch drag.
- **Round 2 rim.** The rim cuts the first and last characters of a full-width history line at the very top and bottom of the view, and the free-centred Sessions list leaves paper above its first row.
- **A lost `list` dict on History** leaves the page marked as loading until Back: Down does nothing, and Up scrolls but loads no older turns.
- **Menu selection.** Coming back to the Menu from a screen starts the selection on `sessions` again.
- **Models on a closed session.** ModelView shows an empty screen when the models fetch fails; for a closed current session it always fails (the hub answers 404).
- **History cap.** History keeps at most 24 turns; scrolling back past that drops the newest turns from the window. Back and reopen History to see them again.
- **Last reply after relaunch.** The fetched last reply is the hub's history text, clipped by the hub to its first 240 characters; Home shows the end of that, so after a relaunch a long reply shows its middle where streaming showed its real end.
- **`showing` outlives the app.** The phone does not clear `showing` when the watch app exits, so the hub keeps sending speed ticks for that session until the phone's socket closes.
- **Sessions list is a snapshot.** The Sessions list does not refresh in place while open; Back and reopen it for new state.
