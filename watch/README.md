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
rm -rf $SDK/.venv
~/.local/share/uv/tools/pebble-tool/bin/python -m venv $SDK/.venv
$SDK/.venv/bin/python -m pip install -r $SDK/sdk-core/requirements.txt
pebble sdk list
```

On the spark the SDK venv was upgraded in place instead of recreated (`pebble-tool/bin/python -m venv --upgrade $SDK/.venv`, then `python` and `python3` in `$SDK/.venv/bin` symlinked to `python3.13`); either gives a 3.13 SDK venv.

Gotchas:

- **`AssertionError: SRE module mismatch`** from `pebble build`: pebble-tool sets `PYTHONHOME` to the SDK's `.venv` and `PYTHONPATH` to its own `sys.path`, so the two venvs must be the same Python minor version. Recreate (or repoint) the SDK venv at 3.13 as in step 3.
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

`watch/app/dev/stub-hub.mjs` is a stand-in hub with canned data and no auth: three live sessions and twenty-three closed ones (so the sessions list pages), 40 history turns per session (some 240 characters), four models, and POSTs that answer `{ ok: true }`. On the `dialog` scene, an `answer` with dictated `text` answers `no_match` with the dialog's options; answered and dismissed requests leave the scene and a new `pending` frame goes out. `GET /dev/settings` answers `{ "DARK": <--dark> }`, which the phone side fetches at launch in the emulator so screenshots can switch theme.

| Scene | What the watch gets |
| --- | --- |
| `dialog` (default) | a `bash` permission dialog on `notesky sync` (`allow`/`deny`) and a finished turn on `pi-web watch` |
| `finished` | the finished turn only |
| `empty` | nothing pending: home shows the current session's last reply |
| `stream` | nothing pending; on each socket open, a `text` tail for `s1` grows by a sentence every 250 ms for 6 s, then `streaming: false` |

```bash
# from the repo root (ws resolves from the root node_modules)
node watch/app/dev/stub-hub.mjs --port 5173 [--scene dialog|finished|empty|stream] [--dark 0|1]

# in another shell
cd watch/app
pebble build
pebble install --emulator emery --logs          # or gabbro; pkjs> lines are the phone side
pebble screenshot --no-open --emulator emery /tmp/emery.png
pebble kill
```

In the emulator the phone side needs no settings: `Pebble.getActiveWatchInfo().model` starts with `qemu`, so with no stored hub URL it uses `http://127.0.0.1:5173`. On a real phone with no URL set it reports `NET: unconfigured` until one is saved in the Clay settings page (Hub URL and Dark).

**Transport in the emulator: `ws`.** The emulator's phone simulator (pypkjs) provides `WebSocket`, so the phone side streams from `/api/watch/stream` and logs `pi-web: ws online`. The long-poll fallback is not exercised there.

State after Task 5 (no watch-side code yet): the logs show the phone side start, connect and report `showing`, and try to send `cfg`, `net`, `home` and `stats` in that order. Every send fails because nothing on the watch opens AppMessage, so each is retried once after 500 ms and then dropped:

```
pkjs> pi-web: ready (emulator)
pkjs> pi-web: send cfg
pkjs> pi-web: send cfg failed
pkjs> pi-web: ws online
...
pkjs> pi-web: send home
pkjs> pi-web: send home failed
pkjs> pi-web: drop home after 2 tries
```

The stub logs `ws open`, `GET /dev/settings`, the `showing` frame for the selected request, and `GET /api/watch/history?session=…&limit=4` (the last reply for home).

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
