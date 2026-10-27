# pi-web watch app

Alloy watchapp (not a watchface): JavaScript runs on the watch via the Moddable SDK, UI is Piu via the pebble-ui library. Targets emery (Pebble Time 2) only.

- Watch code: `src/embeddedjs/` (ES modules; every module must be listed in `manifest.json`). Entry is `main.js`; screens are in `windows/`.
- UI is pebble-ui, the submodule `watch/pebble-ui`: run `git submodule update --init` before `pebble build`. See the `using-pebble-ui` skill.
- Phone code: `src/pkjs/` (plain ES5, CommonJS, `@rebble/clay`). Talks to the hub and relays over AppMessage.
- AppMessage keys are `pebble.messageKeys` in `package.json`; add new keys there first (a test checks `main.js` `KEYS` against them). The MSG/CMD protocol tables are in `.superpowers/sdd/2026-10-27-watch-ui-rewrite/task-7-report.md`; the query `SESSION_ID` came later (Task 9).
- Settings (Clay): Hub URL and Dark theme.
- Shared modules live in `watch/shared/` (`js/` watch-side via manifest paths, `pkjs/` phone-side via relative `require`; `pkjs/package.json` marks it CommonJS for the tests).
- Tests: `node --test watch/app/test/` from the repo root (`npm run test:watch`).

Commands (run in `watch/app`, verified, see `../README.md`; no `--vnc` needed, the emulator runs headless):

    pebble build
    pebble install --emulator emery
    pebble install --emulator emery --logs   # console.log shows as xsHost.c lines
    pebble screenshot --no-open --emulator emery /tmp/emery.png
    pebble kill

Code size is memory in the emulator: the VM runs with `stack 6144, slot 45056, chunk 21504` (`src/c/mdbl.c`, mirrored in `manifest.json`; Home's menu is built during the slide transition, hence the stack). The mod archive (`build/mods/emery/mc.xsa`) is 38,248 B; the emulator ceiling is about 42,500 B with this stack, past which launch fails with `fxMapArchive failed`. Measure after any change with `bash ../pebble-ui/tools/sizes.sh .`; see `../README.md`. Watch-side state is applied in `onReadable` and the windows update in one deferred pass (`main.js`). Never make a new Style (or StatusBar) per update of a window that stays up: Piu keeps every Style a content has used until the next window slide, so take styles from `theme.js` `style()` and set strings in place (text.js `fill`); see `../README.md`, "Styles stay in the chunk heap".

PKJS runs in the emulator on this machine with the Python 3.13 pebble-tool and the prebuilt aarch64 STPyV8 wheel (see `../README.md`, Toolchain); its logs are the `pkjs>` lines of `pebble install --emulator emery --logs`. Phone-side code is also covered by unit tests. A stand-in hub for the emulator: `node watch/app/dev/stub-hub.mjs --port 5173 [--scene default|all|empty|ring|many]` (`many`: twelve rows, the most the phone sends, with long titles and replies; open sessions from it after changing Home or the text window, the chunk heap holds Home under them) from the repo root (`POST /stub/notice`, `/stub/query`, `/stub/dark`, `/stub/stream` to stream a reply into the open session as the real hub does while pi runs). The real hub's loopback internal API is `127.0.0.1:7879` (`internalPort`); `watchAlert` (auto|notification|push|off) picks how a closed app is alerted.

UI details (spec §8a): the header line is the label only (ellipsized, no time; the wire still carries `AT`); Home rows are one Port each, 56 px tall, Gothic 24 Bold title and 18 Bold status line, with a dot only for running and waiting sessions.

See `watch/README.md` and `docs/superpowers/specs/2026-10-16-pebble-watch-design.md`.
