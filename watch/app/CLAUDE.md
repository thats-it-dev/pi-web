# pi-web watch app

Alloy watchapp (not a watchface): JavaScript runs on the watch via the Moddable SDK, UI is Piu. Targets emery (Pebble Time 2) and gabbro (Pebble Round 2) only.

- Watch code: `src/embeddedjs/` (ES modules; every module must be listed in `manifest.json`). Entry is `main.js`.
- Phone code: `src/pkjs/` (plain ES5, CommonJS, `@rebble/clay`). Talks to the hub and relays over AppMessage.
- AppMessage keys are `pebble.messageKeys` in `package.json`; add new keys there first.
- Tests: `node --test watch/app/test/` from the repo root (`npm run test:watch`).

Commands (run in `watch/app`, verified, see `../README.md`; no `--vnc` needed, the emulator runs headless):

    pebble build
    pebble install --emulator emery          # or gabbro
    pebble install --emulator emery --logs   # console.log shows as xsHost.c lines
    pebble screenshot --no-open --emulator emery /tmp/emery.png
    pebble kill

PKJS runs in the emulator on this machine with the Python 3.13 pebble-tool and the prebuilt aarch64 STPyV8 wheel (see `../README.md`, Toolchain); its logs are the `pkjs>` lines of `pebble install --emulator emery --logs`. Phone-side code is also covered by unit tests. A stand-in hub for the emulator: `node watch/app/dev/stub-hub.mjs --port 5173` from the repo root.

See `watch/README.md` and `docs/superpowers/specs/2026-10-16-pebble-watch-design.md`.
