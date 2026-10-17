# pi-web watch app

Pebble watchapp built with Alloy (Moddable SDK on PebbleOS). Targets emery (Pebble Time 2) and gabbro (Pebble Round 2).

## Toolchain

Verified on the spark (aarch64 Linux, Python 3.12.3, 2026-10-16):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh     # uv 0.13.1 -> ~/.local/bin
export PATH=$HOME/.local/bin:$PATH
uv tool install pebble-tool --overrides overrides.txt   # Pebble Tool v5.0.40 (see below)
pebble sdk install latest                               # SDK 4.33.1 (active)
pebble sdk list
```

Plain `uv tool install pebble-tool` fails on aarch64 Linux: `pypkjs` depends on `stpyv8`, which has no aarch64 wheel and its sdist does not build (`ModuleNotFoundError: No module named 'settings'`). Workaround that worked:

1. `overrides.txt` containing `stpyv8; sys_platform == 'never'` (drops the dependency), then `uv tool install pebble-tool --overrides overrides.txt`.
2. `pypkjs` still does `import STPyV8` at import time, so a stub package was dropped into the tool venv at `~/.local/share/uv/tools/pebble-tool/lib/python3.12/site-packages/STPyV8/__init__.py` (permissive placeholder classes). This lets the emulator install and logs work. **Consequence: PKJS (the phone-side JS in `src/pkjs`) cannot run in the emulator on this machine.** Anything exercising PKJS needs an x86_64 machine, a real phone, or a from-source stpyv8 build. Reinstalling or upgrading `pebble-tool` removes the stub.

Full source of the stub (`STPyV8/__init__.py`):

```python
# Local stub: no aarch64 wheel for stpyv8. Lets pypkjs import; PKJS (phone JS) cannot run.
class _Any:
    def __init__(self,*a,**k): pass
    def __getattr__(self,n): return _Any
    def __call__(self,*a,**k): return _Any()
def __getattr__(n): return _Any
class JSContext(_Any): pass
class JSClass: pass
class JSObject: pass
class JSArray: pass
class JSNull: pass
class JSUndefined: pass
class JSError(Exception): pass
class JSIsolate(_Any): pass
class JSLocker(_Any): pass
```

This stub is a workaround to be replaced: the controller is attempting a real aarch64 build of stpyv8 separately (a Python 3.13 tool venv with a real STPyV8 now exists on the spark, so the stub may already be gone).

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

Smoke test: Moddable's `hellopebble` example built, installed on emery, and logged `Hello, Pebble.`. The scaffold built for both platforms and installed on both emulators (default screen is a clock).

## Dev loop

(Filled in with the stub hub in Task 5.)

## Pebble app setup

Mute pi-web notifications in the Pebble phone app so they do not duplicate the watch app's own. (Remaining steps in Task 11.)

## Hardware checklist

(Filled in Task 11.)
