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

Caveat: PKJS does not run in the emulator on this machine today (the `STPyV8` module is a stub, no aarch64 build). Phone-side code must be tested elsewhere or via unit tests.

See `watch/README.md` and `docs/superpowers/specs/2026-10-16-pebble-watch-design.md`.
