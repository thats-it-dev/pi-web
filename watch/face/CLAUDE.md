# pi-web watchface

Alloy watchface (`watchface: true`): JavaScript runs on the watch via the Moddable SDK, UI is Piu. Targets emery (Pebble Time 2) and gabbro (Pebble Round 2) only. The idle screen is the time and four configurable corners (`date` `pi` `hr` `steps` `battery` `weather` `none`); a pending pi-web request will raise a sheet over the bottom third (plan 3).

- Watch code: `src/embeddedjs/` (ES modules; every module must be listed in `manifest.json`). Entry is `main.js`; `idle.js` is the idle screen; `modules/face.js` is the logic (corner strings, layout numbers, the model the phone's dicts apply to) and imports nothing from Piu. Font strings live only in `assets.js`.
- Phone code: `src/pkjs/` (plain ES5, CommonJS, `@rebble/clay`). `face.js` is the phone-side model (sheet selection, `pi` counts, the outbox, the idle policy); `index.js` is wiring only.
- AppMessage keys are `pebble.messageKeys` in `package.json`, in the same order as `KEYS` in `modules/face.js` (a test checks it); add new keys to both.
- Shared modules live in `watch/shared/` (`js/format`, `js/link` via manifest paths; `pkjs/hub` via a relative `require`).
- Tests: `node --test watch/face/test/` from the repo root, or `npm run test:watch` for both watch projects.

Commands (run in `watch/face`, see `../README.md`; the emulator runs headless):

    pebble build
    pebble install --emulator emery          # or gabbro
    pebble install --emulator emery --logs   # console.log shows as xsHost.c lines, the phone side as pkjs>
    pebble screenshot --no-open --emulator emery /tmp/emery.png

A stand-in hub for the emulator: `node watch/app/dev/stub-hub.mjs --port 5173 --scene empty` from the repo root.

Code size is memory in the emulator: the mod archive (`build/mods/emery/mc.xsa`) has a ceiling of about 42.8 KB (see `../README.md`, "Code size is memory"). Measure it after any watch-side change and keep the face well under 42.5 KB. The VM sizes (`stack 5120, slot 43008, chunk 23552`) are in `src/c/mdbl.c` and mirrored in `manifest.json`.

Piu font strings are CSS-like: `"bold 18px Gothic"`, not `"18px bold Gothic"` (that looks for `boldGothic-Regular-18` and the face fails to load).

See `watch/README.md` and `docs/superpowers/specs/2026-10-16-pebble-watch-design.md`.
