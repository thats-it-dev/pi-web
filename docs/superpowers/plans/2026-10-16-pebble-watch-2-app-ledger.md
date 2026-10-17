# SDD ledger — plan: docs/superpowers/plans/2026-10-16-pebble-watch-2-app.md

Spec: docs/superpowers/specs/2026-10-16-pebble-watch-design.md (read; binding authority; §5.1, §6.4, §7 revised 2026-10-16 for the WebSocket stream).
Worktree: .claude/worktrees/pebble-watch-app on branch feat/pebble-watch-app (main checkout on master at 7888ae6).
Plan base commit: 7888ae6 (docs: plan 2). Baseline: npm install ok, npm test green (18 vitest files / 95 tests in app; hub, shared, bridge node:test suites green).

## Pre-flight scan

Pairs sharing a file or interface:

| Tasks | Produces vs consumes | Finding |
|---|---|---|
| 1 ↔ 2 | `WatchService.subscribe(fn)`, `subscriberCount()`, `WatchStreamFrame` / watch-stream.ts fans frames to sockets | consistent |
| 2 ↔ 5 | `ws` installed as a hub dependency (hoisted to root node_modules) / stub-hub.mjs `import { WebSocketServer } from "ws"` | consistent; the stub runs from the repo root |
| 2 ↔ 5 | Vite proxy `ws: true` + `proxyReqWs` header stamping / emulator pkjs hub URL `http://127.0.0.1:5173` | consistent |
| 4 ↔ 5 | `createHubClient` callbacks `onPending/onText/onStatus`, methods `showing/get/post` / bridge deps.hub and bridge.onStatus | consistent; status `unconfigured` originates in index.js, not hub.js — bridge accepts it |
| 5 ↔ 6 | AppMessage dictionary and row formats (one table in the plan) / model.js `apply`, `parseRows` | consistent |
| 5 ↔ 7 | `home`/`stats`/`net`/`result` dicts / Home view via `model.apply` kinds | consistent |
| 6 ↔ 8 | `homeRows(home)` gains a second `sayIt` argument in Task 8 | sequential edit, fine |
| 6 ↔ 10 | `lists.history` 24-row cap added in Task 10 | sequential edit, fine |
| 3 ↔ 4..11 | root `test:watch` = `node --test watch/app/test/` with only `.gitkeep` until Task 4 | **Ruling below** |
| 7 ↔ 9 | hold-Select → `controller.goTo("MenuView")` logged in 7, view created in 9 | consistent |

Per-task self-consistency:

| Task | Check | Finding |
|---|---|---|
| 1 | tests use `h.conv.partial/streaming`, `clock.t`, `ev()` from watch.test.ts; `message_end` text from the event's message | agrees |
| 2 | 403/404 via `ws` client `unexpected-response`; ping test with `pingMs: 20`; close test last | agrees |
| 3 | toolchain commands unknown-environment (headless qemu, `--ai` flag) with explicit fallbacks | acceptable; README records what worked |
| 4 | fake socket/xhr/timers; back-off 1 s→30 s; poll timeout 35 s; post timeout 15 s | agrees |
| 5 | outbox coalescing kinds, stats limiter, packRows 1000 B, history OFFSET semantics | agrees with the dictionary table |
| 6 | `.mjs` tests importing ESM `.js` modules from a package without `"type"` (Node 26 syntax detection) | agrees |
| 7 | Back = dismiss then FFI `pi_exit()`; fallback return false | agrees; ruling recorded if fallback used |
| 8 | say-it state machine unit-tested; dictation hardware-only fallback | agrees |
| 9 | `emu-button --hold` may not exist; fallback via `menu` row | agrees |
| 10 | 24-turn cap drops newest when prepending | agrees with spec §12 "at most 24 turns" |
| 11 | TEXT_MAX halves to 120 if the emulator drops 240-char payloads | agrees with spec §15 |

Ruling: Task 3 creates `watch/app/test/scaffold.test.js` (asserts `package.json` `pebble.uuid` matches the UUID regex and `targetPlatforms` deep-equals `["emery","gabbro"]`) instead of a `.gitkeep`, so `node --test watch/app/test/` has a file to run from Task 3 on — costs one trivial test file if wrong.

## Progress
Task 1: dispatched (BASE 7888ae6, implementer sonnet)
Task 1: Ruling: reviewer's plan-mandated finding (final `text` frame fires on every `message_end`, any role) is upheld — spec §5.1 says "partial assistant message" and "one final frame", so the final frame requires `message.role === "assistant"`; the brief's decision text is amended in spirit. Costs nothing if wrong beyond a missed final frame for a non-assistant message the watch never shows anyway.
Task 1: minor (deferred): a throwing subscriber aborts the fan-out (same pattern as the existing waiter loop); consider try/catch around subscriber sends when sockets attach (Task 2 may do it).
Task 1: minor (deferred): the second showing() test lacks negatives (same session re-reported, non-streaming session, empty partial).
Task 1: note for Task 2: showing() emits the text tail synchronously, before the microtask `pending` frame that confirms the switch; clients key on sessionId.
Task 1: fix round 1/5 (2 addressed, 0 open — assistant-only final frame; textAt set in showing(); commits afc43aa..c4ca71a). Controller re-ran full hub suite: 256 pass, typecheck clean.
Task 1: complete (commits 7888ae6..c4ca71a, review clean, 1 ruling)
Task 2: dispatched (BASE c4ca71a, implementer sonnet)
Task 2: ⚠️ resolved — implementer narrowed checkHostAndLogin's parameter type (auth.ts, behaviour unchanged) and made the bad-frame test poll for three log lines; both accepted as observations, reviewer will judge.
Task 2: Ruling: reviewer's plan-mandated finding (socket dropped after one missed pong) upheld — spec §5.1 says two; the brief's algorithm was my simplification. Fix: per-socket miss counter, terminate at 2. Costs: a dead socket lingers up to 60 s instead of 30 s.
Task 2: minor (deferred): 403/404 refusals write then destroy immediately (may lose the status line under backpressure).
Task 2: minor (deferred): 50 ms sleep in "closed client is forgotten" test; 403/404 status helper has no timeout; 404 upgrades not logged.
Task 2: minor (deferred): no end-to-end test of the Vite proxyReqWs stamping (verified by Task 5's emulator smoke instead).
Task 2: fix round 1/5 (3 addressed, 1 open — ping loop still terminates after one unanswered ping (counter incremented before the check), test non-discriminating; commits c97de44..914ae17)
Task 2: fix round 2/5 (1 addressed, 0 open — ping loop checks missed>=2 before increment, discriminating test; commits 914ae17..9f39720)
Task 2: complete (commits c4ca71a..9f39720, review clean, 1 ruling)
Task 3: dispatched (BASE 9f39720, implementer sonnet)
Task 3: ⚠️ environment — stpyv8 (pypkjs's JS engine) has no Linux aarch64 wheel (checked cloudflare/stpyv8 v13.1.201.22 assets: x86_64 + macOS arm64 only); implementer stubbed it, so PKJS cannot run in the emulator on the spark. Spike agent dispatched to find/build an aarch64 STPyV8; if it fails, Ruling pending: watch-side dev fixtures for emulator screenshots, pkjs↔watch integration verified on hardware only.
Task 3: Ruling: `@rebble/clay` ^1.1.0 replaces `pebble-clay` (1.0.4 lacks gabbro and breaks the build) — accepted; costs nothing if wrong beyond a package swap.
Task 3: minor (deferred): scaffold's generated CLAUDE.md/.cursor/README.md committed under watch/app (spec §12 says keep CLAUDE.md; the rest is noise to prune at final review).
Task 3: ⚠️ resolved — build/install/screenshot/2-pass evidence accepted from the implementer's report; reviewer did not rebuild by design.
Task 3: minor (deferred): implementer's report asserts evidence without pasted output.
Task 3: fix round 1/5 (4 addressed per implementer, re-review pending — accurate CLAUDE.md, .cursor and generic README removed, package name/author, stub source in README; commits 06f666a..b6ee43f)
Task 3: complete (commits 9f39720..b6ee43f, review clean, 1 ruling)
Task 3: carried to Task 5: reconcile watch/README.md and watch/app/CLAUDE.md on the PKJS-in-emulator state once the STPyV8 spike reports (README line ~42 has process narration to drop).
Task 4: dispatched (BASE b6ee43f, implementer sonnet)
Spike: STPyV8 WORKING on aarch64 — prebuilt cp313 wheel from the andrwj/stpyv8 fork (v13.1.201.22, manylinux_2_39_aarch64); pebble-tool venv moved to Python 3.13 with an overrides file dropping stpyv8, wheel installed into the venv, SDK 4.33.1 venv repointed at python3.13 + requirements reinstalled (else "SRE module mismatch"). PKJS logs appear in `pebble install --emulator emery --logs`. Stub is gone. Report: .superpowers/sdd/2026-10-16-pebble-watch-2-app/spike-stpyv8-report.md. Ruling: the emulator dev loop is back in scope for Tasks 5, 7–11 as planned; Task 5 rewrites the toolchain section of watch/README.md and the PKJS caveat in watch/app/CLAUDE.md from the spike report. Costs if the fork's wheel is untrustworthy: dev-only tooling on the spark, not shipped code.
Task 4: minor (deferred): `new WebSocket()` throwing synchronously in openSocket kills the reconnect chain; an exception in onPending inside the poll callback kills the poll loop (wrap / poll() first).
Task 4: minor (deferred): no connect timeout or liveness watchdog on the socket; trailing-slash base URL yields `//api`; failed pre-open `showing` POST not retried; test gaps (close+error single timer, XHR abort on close).
Task 4: complete (commits b6ee43f..b68b4d4, review clean)
Task 5: dispatched (BASE b68b4d4, implementer opus)
Task 5: implementer notes — emulator pkjs transport is ws; session pick while requests pending keeps that session on Home until a new request arrives (spec reading, Task 7 confirms); list chunks 900 B of rows.
Task 5: ⚠️ resolved — hub shapes confirmed from hub/src/watch-routes.ts and protocol.ts: `pending.showing` is a request-id string; POST prompt {sessionId,text}, model {sessionId,provider,modelId}; models → {current:{provider,id,name}|null, models:[...]}; history `before` is exclusive (turns with i < before), as the stub does.
Task 5: minor (deferred): clip() by UTF-16 units may split a surrogate pair; empty history page sends OFFSET 0; `show` pin never cleared by hello or when the session leaves the list; a `home` sent mid-stream carries the older lastText (Task 7 must not let home.TEXT overwrite a live text tail).
Task 5: fix round 1/5 (5 fixed per implementer, re-review pending — last-reply cache invalidation, dictBytes budget, README narration, clipping, Clay try/catch; commits 6cf2302..215fa5d)
Task 5: minor (deferred): re-fetch of the last reply can race an in-flight fetch (textFetching) and cache the older response; clipTo may split a surrogate pair.
Task 5: complete (commits b68b4d4..215fa5d, review clean)
Task 5: carried to Task 7: remove the README Dev-loop sentence "Until the watch side opens AppMessage…" once the watch side lands; Home must not let home.TEXT overwrite a live text tail.
Task 6: dispatched (BASE 215fa5d, implementer sonnet)
Task 6: Ruling: LECO 1976 could not be fetched (fontlibrary.org page has no download; no local copy on the spark) — the plan's fallback applies: system Gothic 14/18 via `FONT_FAMILY = "Gothic"`, no TTF, README known issue. Michael's typography call (LECO) is not met; swapping the family in assets.js + a manifest font resource restores it once a licensed TTF is supplied. Costs: the watch app ships in Gothic until then.
Task 6: note — mdbl.c now sets creation sizes on the non-debug path too (previously NULL → 32 kB default); manifest lists only existing modules, Task 7 adds the rest.
Task 6: minor (deferred): dim #AAAAAA unconditional (poor contrast on light paper — Task 7 picks per theme); bodyRight lacks leading; apply("list") checks a plain object (prototype names pass); sessions ctx can be NaN from malformed input; menuMeta leading separator with empty model; a few test gaps.
Task 6: complete (commits 215fa5d..84bfd75, review clean, 1 ruling)
Task 7: dispatched (BASE 84bfd75, implementer opus)
Task 7: implementer notes — Piu Inverter draws nothing on emery/gabbro (ink bar + paper text used instead); the watch holds one unread AppMessage so back-to-back sends were lost → 100 ms gap after each ack added in pkjs/index.js (mitigation); VM sizes retuned (slot 40960, smaller message buffers, ~17 KB heap free); touch untestable in the emulator; pi_clock_24h FFI added; FFI exit works.
Task 7: Ruling: the 100 ms post-ack gap (phone) is accepted for v1 as a mitigation, not flow control — the watch's native Message holds one unread dict and a slow rebuild in the read callback can still lose one. Hardening carried to Task 11: (a) `onMessage` applies to the model and defers the rebuild out of the read callback; (b) the phone coalesces the launch burst; (c) README hardware checklist gets "watch for lost AppMessages (a `result` lost → `failed` after 10 s for an answer that went through)"; (d) sequence-number + `hello` resync noted as the follow-up if hardware shows loss. Costs if wrong: a misleading `failed` on the watch after an answer that succeeded.
Task 7: minor (deferred): light-theme CTX track contrast; stale toolbar for ~1 s after an answer (phone ordering); untaken `results` accumulate; feedback timers survive a theme redisplay.
Task 7: ⚠️ resolved — touch path untestable in the emulator (hardware checklist); `./exit.c` FFI path resolves (build passed); whether native Message re-fires onWritable after a nack is a hardware check (link retries every 100 ms up to 10 tries only while writable).
Task 7: fix round 1/5 (4 fixed per implementer, re-review pending — shownId for Back/REQ_ID, exiting reset, rule gap, track colour; commits 9016cae..9f8f9bc)
Task 7: minor (deferred): after a failed exit with a request shown, the next Back resends dismiss and retries exit rather than returning false to the firmware (comment in leave() optimistic).
Task 7: complete (commits 84bfd75..9f8f9bc, review clean, 1 ruling)
Task 8: dispatched (BASE 9f8f9bc, implementer opus)
Task 8: implementer notes — emulator dictation unavailable (error 3; error path verified; transcript states verified via a temporary hook, removed); chunk raised 19456→23552 after `memory full` on the no_match screen; peak heap 115.7/122.3 KB (~6.5 KB free) — MEMORY RISK carried to Task 9/10; fixed a menu repeat-timer leak on rebuild; stub hub gained --delay; theme change mid say-it drops the transcript.
Task 8: Ruling: lists in Tasks 9 and 10 must be virtualised (build only the visible rows plus one, recycle on scroll) or fall back to Poco drawing for that screen (spec §15) — at ~6.5 KB free a Piu container per row/turn will not fit. Costs: more view code; a scroller that is not a plain Piu Scroller.
Task 8: minor (deferred): partial rebuild (replace only Query + Menu) instead of container.empty() on say-it steps would cut the transient double-tree peak and may allow chunk back toward 19456; dead sayIt fields (cmdId/reqId) after reset; `failed` label written to row 0 by index (coupling); theme change mid say-it drops the transcript.
Task 8: fix round 1/5 (4 fixed per implementer, re-review pending — transcript tail lines, per-round Dictation, pending timer cleared on undisplay, results cap; steady free heap ~9.3 KB on Home, ~4.8 KB at peak (cause unknown, same without dictation); commits 491a9f3..592f571)
Task 8: complete (commits 9f8f9bc..592f571, review clean, 1 ruling)
Task 9: dispatched (BASE 592f571, implementer opus)
Task 9: BLOCKED (round 1) — app no longer boots in the emulator with the three new views: fxMapArchive "memory full" at launch. Analysis from the report's numbers: in QEMU the mod archive is copied into the 121.8 KB app heap (HEAD: 41.8 KB archive + 69.6 KB VM ≈ 111 KB, ~12 KB free at main.js; full Task 9: 51.1 KB archive → nothing left for the MAPS/id tables). Every KB of bytecode costs a KB of heap in the emulator. On hardware the archive is reportedly mmapped from flash (TARGET_QEMU branch in ArchivePebbleResource.c), so the hardware ceiling is unknown and probably looser. WIP on branch wip/task-9-menu-screens-blocked (57d0a1c): virtualised Menu, listWindow.js + tests, MenuView/Sessions/ModelView, Home wiring, typings include dropped.
Task 9: Ruling: (1) code diet first — drop piuView's slide transitions (instant screen swap), simplify Menu's bounce animation, one shared list-screen base for Menu/Sessions/Model(/History), simpler ModelView; target: all four screens boot in the emulator at 5120/40960/23552. (2) If the diet is not enough, add a dev-only manifest-subset build (`watch/app/dev/build-subset.mjs <views…>`) so each screen can be verified on the emulator with a subset of views, document it as an emulator-only limitation, and put "does the full build boot on the Time 2?" at the top of the hardware checklist. Costs if wrong: (1) loses the slide animations (spec never required them); (2) full-build screenshots become hardware-only and the emulator cannot prove the complete app fits.
Task 9: unblocked via the code diet (archive 51.1→41.5 KB, MAPS 7636→5836); slot raised 40960→43008 (model pick aborted at 40960); peak firmware heap 119.6/122.1 KB (~2.5 KB free); multi-chunk list path covered by tests only (stub sends 26 rows in one chunk); subset-build script not needed.
Task 9: minor (deferred): list rows written in place and never truncated on a shorter re-page (MenuView re-pages without reset); ModelView has no error cue on a failed models fetch (TOTAL -1); opens on current only if in the first chunk; blank band under 4 models; Sessions → goHome briefly shows the previous session's Home; rowAt before the leaving check.
Task 9: ⚠️ resolved — "hold Select on any screen" (§7.6) is implemented on Home only; list screens pick on release — accepted for v1 (Menu is one Back away from any list), carried as a deferred minor for the final review.
Task 9: fix round 1/5 (3 fixed per implementer, re-review pending — redisplay defer + menu guard, fired-timer pattern + constants, row truncation; commits 1c5cc01..036d752)
Task 9: complete (commits 592f571..036d752, review clean, 2 rulings)
Task 10: dispatched (BASE 036d752, implementer opus)
Task 10: implementer notes — full build 45702 B / MAPS 6496 does NOT boot in the emulator (ceiling ≈ 42.8–42.9 KB); History verified with a `MenuView History` subset build (dev/build-subset.mjs); no Scroller/Text (each Text ≈ 1 KB chunk): turns wrapped into lines, one Label per visible line, reused on scroll; 24-turn cap holds; ~2.1 KB free at peak on the debug subset.
Task 10: Ruling: Task 11 must include a further diet of ≥ 3 KB (Home is 9.3 KB bytecode; candidates: fold the say-it rendering helpers, drop pi_clock_24h FFI if the typings expose a 12/24 setting, dedupe status/toolbar builders via ListScreen) with the target that the FULL build boots in the emulator again. If it still does not, the subset build remains the emulator dev loop, README states the limitation with the numbers, and the first hardware-checklist item (full build boots on the Time 2) decides. Costs if wrong: time spent on a diet the hardware may not need.
Task 10: ⚠️ resolved — tool-line text comes from the hub's turnsFrom as `<name> · <line>` (the stub fixture lacks the dot: cosmetic); a failed page (TOTAL -1, MORE 0) sets complete (MORE !== 1), so `loading` clears.
Task 10: minor (deferred): Down during a page load can jump to the trimmed bottom (ignore Down while loading, or re-anchor to nearest surviving i); dropped newest turns need Back+reopen (document); long tool lines have no `…`; `you` lines measured with styles.body; wrap recomputed per render; theme change loses scroll position; README "keep the archive near 42 KB" sentence stale.
Task 10: complete (commits 036d752..eb1be47, review clean, 1 ruling)
Task 11: dispatched (BASE eb1be47, implementer opus)
Task 11: implementer notes — diet landed: full build 42334 B / MAPS 5940 boots on emery and gabbro (~450 B margin); peak heap ~1.8 KB free; npm test green (shared 10, hub 264, bridge 34, app 95, watch 74), typecheck clean; gabbro History line ends touch the rim; History Down guard code-verified only; long replies show their tail (hub sends last 240 chars).
Task 11: Ruling: on Round 2, lists shorter than the view anchor at the top (selection centred only while scrolling) — spec §7.10 "keeps the selected row centred, as the words example does" is read as scrolling behaviour; three rows centred in a circle leave the query block floating. Costs: a reviewer may read §7.10 the other way; one-line change in listWindow if Michael wants always-centred.
Task 11: Ruling: one light-theme screenshot per platform suffices (home-dialog); the theme is a global inversion.
Task 11: ⚠️ resolved — `PI-WEB 0/0` with nothing pending is spec §7.5's stated status line; `watch.hour12` is cited from the SDK's global.d.ts (hardware check item); `Timer.clear(undefined)` no-op exercised on the Home → Menu walk.
Task 11: minor (deferred): a lost `list` dict leaves History's `loading` true in both directions (Known issues); failed theme store no longer logged; EXIT_MS timer not cleared after flush (done guard covers); a `text` frame for another session still rebuilds the query block; Round-2 value rows centre the title in the shortened box.
Task 11: fix round 1/5 (4 fixed per implementer, re-review pending — n clamp (didn't-match line shows alone with 4 options), round bar 32 px + values 64 px in, batch break after theme rebuild + History port guard, README numbers; archive 42455 B / MAPS 5948 boots both; commits c0bfa68..1f74e35)
Task 11: complete (commits eb1be47..1f74e35, review clean, 2 rulings)
Final review (opus, 7888ae6..1f74e35): ready to merge WITH FIXES — 4 Important (home dict not budgeted to the 1100 B inbox; empty text tails blank the reply during thinking/tool calls; real-hub dev loop 403s on Host and was never run; malformed hub URL wedges at CONNECTING), minors, all rulings agreed. One fix wave dispatched (opus, FIX_BASE 1f74e35).
Final review: minor (deferred, final): no tail re-sent on reconnect; §7.2 `null` showing on exit not implemented; §7.7 sessions list does not refresh in place; head-clip vs tail for the fetched last reply; WebSocket readable from a tailnet web page (inside the accepted §9 trade; optional Origin refusal on upgrade after confirming PKJS sends none); vendored skill lacks LICENSE file.
Final fix wave: 4 commits (f7e928f phone F1+F4, 92a968b hub F2, 3f275cc proxy+README F3, db29327 stub/docs/pin/provenance F5+F6); npm test green (shared 10, hub 265, bridge 34, app 95, watch 79), typecheck clean, archive unchanged 42455 B. REAL-HUB END-TO-END VERIFIED on the emery emulator 2026-10-17: pi session created through Vite, bash permission dialog shown on the watch (PI-WEB 1/1), answered with Select, command ran, finished turn shown, Back dismissed. Dev hub ran on 7879 (production hub holds 7878).
Final: minor (deferred): `/api/watch/prompt` right after `POST /api/sessions` returned `gone` and the session vanished from the list (hub quirk; `/api/sessions/<id>/commands` worked); two clipped options with identical display text map to the first; upstream skill publishes no LICENSE (PROVENANCE.md says so); a stray gabbro emulator with a display was running on the spark and `pebble kill` did not stop it.
Final fix wave: re-review clean (F1–F6 addressed, no new breakage; commits 1f74e35..db29327). Plan 2 complete: 26 commits 7888ae6..db29327.
