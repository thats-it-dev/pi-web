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

`watch/app/dev/stub-hub.mjs` is a stand-in hub with canned data and no auth: three live sessions and twenty-three closed ones (so the sessions list pages), 40 history turns per session (some 240 characters), four models, and POSTs that answer `{ ok: true }`. On the `dialog` scene, an `answer` with dictated `text` answers `no_match` with the dialog's options; answered and dismissed requests leave the scene and a new `pending` frame goes out. `--delay <ms>` holds every POST's answer that long, to see the watch's `sending…` state. `GET /dev/settings` answers `{ "DARK": <--dark> }`, which the phone side fetches at launch in the emulator so screenshots can switch theme.

| Scene | What the watch gets |
| --- | --- |
| `dialog` (default) | a `bash` permission dialog on `notesky sync` (`allow`/`deny`) and a finished turn on `pi-web watch` |
| `finished` | the finished turn only |
| `empty` | nothing pending: home shows the current session's last reply |
| `stream` | nothing pending; on each socket open, a `text` tail for `s1` grows by a sentence every 250 ms for 6 s, then `streaming: false` |

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

**What the `dialog` scene shows.** The watch sends `hello` on launch and the phone answers with `cfg`, `net` and `home`, then `stats`. The Home screen shows `PI-WEB 1/2` and the time, the toolbar for `notesky sync` (`CTX` bar, `18%`, `--` for speed, `QWEN3`), the query `bash: Allow bash?` / `git push origin main`, and the rows `allow` `deny` `say it` with `allow` selected. `pebble emu-button --emulator emery click down` then `click select` answers `deny`: the row shows `…`, then `sent` for a second (the stub logs `POST /api/watch/answer`), then the finished turn on `pi-web watch` (`PI-WEB 1/1`, rows `say it` `dismiss`). `click back` dismisses it (`POST /api/watch/dismiss`) and exits to the watchface. Hold Select (`push select`, wait, `release select`) logs `pi-web: hold select -> MenuView` until the menu exists. Touch (tap a row to pick it) has no `pebble` command; it is untested in the emulator. Screenshots are in `watch/screenshots/`.

**Say it in the emulator.** Picking `say it` opens the firmware's dictation screen (a pulsing dot), but the emulator cannot transcribe: after a press of Select it shows `Dictation is not available.` and the app logs `pi-web: dictation error 3`, then returns to the same rows. The transcript states (`sending…`, `sent`, `didn't match: allow, deny`) were checked with a temporary hook that fed a transcript in place of dictation (since removed): on the `dialog` scene the stub answers `no_match`, on `finished` and with nothing pending (a `prompt`) it answers ok. Run the stub with `--delay 5000` to see `sending…`.

**Pacing.** The watch's `pebble/message` holds one unread dict; one that lands before the JS has read the previous is overwritten, and the firmware acks on receipt. The phone side therefore waits 100 ms after each ack before the next send (`ACK_GAP_MS` in `src/pkjs/index.js`). Without it, `net` and `stats` sent right after `cfg`/`home` were lost.

**Memory.** The VM runs with `stack 5120, slot 40960, chunk 23552` (`src/c/mdbl.c`; the words example's `slot 31744` aborts with `memory full` once the Home screen is built, and a larger total fails `fxMapArchive` at launch). AppMessage buffers are 1100 bytes in, 640 out (`modules/link.js`), not the 8 KB default each. At exit the firmware reports about 105 KB of 122 KB heap used; the high-water mark is now about 117.5 KB, the same with or without a dictation round. On the Home screen, `heap_bytes_free()` read about 9.3 KB before, during and after say-it rounds; each round's `Dictation` is closed when it ends. The chunk heap went from 19456 to 23552 for the transcript screens: a Piu `Text` is chunk-heavy, and the no_match screen (query, transcript, options) aborted with `# Chunk allocation … failed` at 19456.

### With the real hub

```bash
npm run dev -w hub      # one shell
npm run dev -w app      # another; serves on http://127.0.0.1:5173
```

The emulator's default hub URL is `http://127.0.0.1:5173`, the same address; Vite's `/api` proxy (with `ws: true`) adds the `Tailscale-User-Login` header the hub requires, as `tailscale serve` would. `/dev/settings` is stub-only; against the real hub that fetch fails quietly and the stored theme stays. To point at a hub on the tailnet instead, set the Hub URL in the settings page (`pebble emu-app-config --emulator emery`), for example `https://<hostname>`.

## Pebble app setup

Mute pi-web notifications in the Pebble phone app so they do not duplicate the watch app's own. (Remaining steps in Task 11.)

## Hardware checklist

(Filled in Task 11.)

- dictation: hardware only (the emulator shows the dictation screen but cannot transcribe; check `say it` end to end on the watch: confirm screen, `sending…`, `sent`, and `didn't match` on a dialog).

## Known issues

- The LECO 1976 font could not be fetched (fontlibrary.org serves no download for it), so the UI uses the system `Gothic` font (`FONT_FAMILY` in `app/src/embeddedjs/assets.js`). Dropping a licensed TTF into `app/src/embeddedjs/assets/fonts/` and a `resources` entry in the manifest would restore it.
