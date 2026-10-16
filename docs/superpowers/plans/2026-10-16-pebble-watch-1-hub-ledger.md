# SDD ledger — plan: docs/superpowers/plans/2026-10-16-pebble-watch-1-hub.md

Spec: docs/superpowers/specs/2026-10-16-pebble-watch-design.md (read; binding authority).
Worktree: .claude/worktrees/pebble-watch on branch feat/pebble-watch (main checkout left on master).
Plan base commit: 137ba45 (chore: ignore .claude/worktrees).

## Pre-flight scan

Pairs sharing a file or interface:

| Tasks | Produces vs consumes | Finding |
|---|---|---|
| 1 ↔ 7 | `checkWatchRequest(cfg, headers, token)` / server.ts calls it for `/api/watch/*` | consistent |
| 1 ↔ 9 | `checkHostAndLogin` / webhook mount uses it | consistent |
| 2 ↔ 6 | `SessionHandle.observe(fn)` and `pendingTool?()` / WatchService taps streams and names the tool | consistent; FakeHandle gets `pendingToolValue` in T2 and `dialogs`, `stats`, `models` fields in T5/T6 — three edits to the same support file, fine |
| 3 ↔ 6 | `LiveStats` in shared / WatchService constructs per handle | consistent (same API, new path) |
| 4 ↔ 5 | `matchOption(text, options): Match` / `answer()` text path | consistent; T5 maps `ambiguous` → wire `no_match` |
| 5 ↔ 7 | `WatchService` methods incl. `waiterCount()`, `wait(since, maxMs)` / routes | consistent |
| 5 ↔ 9 | `currentTarget()`, `answer()`, `startRingSession()` (added in T9 to watch.ts) / webhook handler | consistent |
| 5 ↔ push-watch tests | `watchTurns` replaces inner logic; push-watch.test.ts must stay green | plan requires it; OK |
| 7 ↔ 9 | both edit server.ts auth switch; T7 moves `readJson`/`sendJson` to `hub/src/http.ts` | sequential, no conflict |
| 7 ↔ 10 | `HealthInfo.watch` / app reads it | consistent |
| 8 ↔ 9 | `verifyIndex`, `parseMultipart`, `ReplayCache` / handler | consistent |

Per-task self-consistency:

| Task | Check | Finding |
|---|---|---|
| 1 | tests vs code: bearer case-insensitive prefix, length-safe timingSafeEqual | agrees |
| 2 | registry reap test needs `now` option on Registry | exists (`RegistryOptions.now`) |
| 3 | app test keeps importing `./live-stats.ts` re-export | agrees |
| 4 | table includes "allow al" → ambiguous (prefix of two) | agrees with staged matching |
| 5 | `WatchAnswerResult` declares `ambiguous` but wire is `gone`/`no_match` | plan says collapse; Ruling below |
| 6 | tps test drives events via `h.push` (FakeHandle.push fans to observers after T2) | agrees |
| 7 | weather cache key `toFixed(1)` | agrees with spec "rounded coordinate" |
| 8 | signature prefix uses `1`/`0`, not the `test` field | agrees with Index docs (verified 2026-10-16) |
| 9 | 25 MB body cap vs server.ts `MAX_BODY` 50 MB | separate reader; fine |
| 10 | vitest test on a pure helper, not Lit render | agrees |
| 11 | docs only | n/a |

Ruling: `WatchAnswerResult.reason` is `"gone" | "no_match"` only on the wire; `matchOption`'s `ambiguous` collapses to `no_match` with `options` — simpler for the watch, which shows the options either way — costs nothing if wrong beyond a later type widening.

## Progress
Task 1: dispatched (BASE 137ba45, implementer sonnet)
Task 1: ⚠️ resolved — writeAtomic mode only applies on create; same as push.ts, tmp is renamed over; not a gap.
Task 1: minor (deferred): auth.ts → watch-secrets.ts → push.ts pulls web-push into the auth import graph (writeAtomic); a small fs-util module would fix it.
Task 1: minor (deferred): auth.ts header comment stale ("every request must come from an allowed Origin"); watch routes are exempt.
Task 1: minor (deferred): no test for valid-JSON watch.json with malformed fields (watch-secrets.ts:110 branch).
Task 1: minor (deferred): slice(7) magic number tied to the "bearer " regex in watch-secrets.ts.
Task 1: complete (commits 137ba45..d79eb97, review clean)
Task 2: dispatched (BASE d79eb97, implementer sonnet)
Task 2: ⚠️ resolved — reported suite pass accepted from the implementer's report (160/160); reviewer did not re-run by design.
Task 2: minor (deferred): rpc observe test only asserts an "event" was seen, not parity with subscribe (e.g. handle_gone).
Task 2: minor (deferred): no test for BridgeHandle.observe.
Task 2: complete (commits d79eb97..dca9972, review clean)
Task 3: dispatched (BASE dca9972, implementer sonnet)
Task 3: ⚠️ resolved — partialDeepStrictEqual exists from Node 22.13 (engines >=22.18); this machine runs 26. Not a gap; kept as a deferred minor for the warning risk on 22.
Task 3: ⚠️ resolved — deepEqual/partialDeepStrictEqual in place of toEqual/toMatchObject is the necessary mapping; cases are the two named ones.
Task 3: minor (deferred): shared/test/live-stats.test.ts uses assert.partialDeepStrictEqual (experimental on 22.x, may warn); deepEqual on the full object avoids it.
Task 3: minor (deferred): delta("a".repeat(0)) no-op carried over from the app test.
Task 3: complete (commits dca9972..b4c5ab3, review clean)
Task 4: dispatched (BASE b4c5ab3, implementer sonnet)
Task 4: Ruling: plan test row `"allow al" → ambiguous` contradicts spec §5 ("starts with or contains the text as a whole word"). Spec wins: stage 2 is option.startsWith(text) with a word boundary after it; no reverse "text begins with option" rule. `"allow al"` → none; the ambiguous case becomes options ["allow once","allow always","deny"] with text "allow". — keeps routing predictable from the wrist (spec anti-goal) — costs: some loose speech ("allow it") falls to no_match and the watch shows the options again.
Task 4: ⚠️ resolved — reported test results accepted (22 pass, typecheck clean).
Task 4: minor (deferred): findAllow/findDeny get untrimmed options in matchOption stage 4 (stages 1-3 trim).
Task 4: minor (deferred): \W is ASCII-only; internal whitespace runs not normalised for yesNo; no tests for regex-special input or deny synonyms.
Task 4: complete (commits b4c5ab3..f950b0f, review clean, 1 ruling)
Task 5: dispatched (BASE f950b0f, implementer opus)
Task 5: ⚠️ resolved — matcher behaviour was reviewed in Task 4; reported 201/201 accepted.
Task 5: Ruling: reviewer minor #1 (prompt() deletes the session's outcome after the await, so a fast reply's finished request can be lost) is load-bearing for "say it" and the ring; Task 6 fixes it (delete the captured outcome before sending). — costs: none if wrong beyond a redundant delete.
Task 5: Ruling: reviewer minor #2 — answer()/prompt() on a session the registry can't find (HttpError 404 from ensure) returns { ok: false, reason: "gone" } instead of throwing; other errors propagate to the route. Task 6 implements. — costs: a deleted session reads as "already answered" on the watch, which is the honest outcome.
Task 5: minor (deferred): dialog id recovered by slicing the request id (assumes no ":" in session ids).
Task 5: minor (deferred): cursor bumps on every registry message (spurious long-poll wakes on renames/bridge changes).
Task 5: minor (deferred): rejected-answer path (handle.command ok:false → gone) untested because FakeHandle returns ok:true for unknown ids.
Task 5: minor (deferred): wall-clock bounds in watch.test.ts wait tests (<500ms) could flake on a loaded box; temp dirs not cleaned; stray second state_changed in a turns test.
Task 5: complete (commits f950b0f..9a4722f, review clean, 2 rulings carried to Task 6)
Task 6: dispatched (BASE 9a4722f, implementer opus)
Task 6: Ruling: implementer deletes only the captured outcome entry, after a successful send (not before) — keeps the finished card when the send fails; accepted over my wording.
Task 6: ⚠️ resolved — clean test output accepted from report; bridge tps null is plan-scoped.
Task 6: minor (deferred): loadClosed() can resolve out of order (older index.list overwrites newer); a sequence counter fixes it.
Task 6: minor (deferred): closed-session cache refreshes only on hub-side triggers; files changed by an un-bridged pi outside the hub reorder late.
Task 6: minor (deferred): one-poll flicker of pending().sessions when a session closes before loadClosed lands.
Task 6: minor (deferred): speed ticks stop when showingState clears (sessionId lost) until the app re-reports showing; app re-reports on every screen change per spec §7.5, so accepted.
Task 6: minor (deferred): closedSession duplicates sessionTitle's chain and TITLE_MAX; non-string tool args print [object Object]; history() calls snapshot() twice; pending() builds the full session list for currentTarget()/health().
Task 6: minor (deferred): tests: registry-drop-without-handle_gone path not isolated; before=0 and before>total unasserted; three pure-function tests not seen red.
Task 6: complete (commits 9a4722f..1224dfe, review clean, 1 accepted variation)
Task 7: dispatched (BASE 1224dfe, implementer sonnet)
Task 7: Ruling: plan-mandated order (503 before checkWatchRequest) conflicts with spec §9 (no new way in that bypasses the Tailscale identity check). Spec wins: checkHostAndLogin first, then 503-if-unconfigured, then bearer. — costs nothing if wrong.
Task 7: ⚠️ resolved — prompt on an unknown session returns 200 {ok:false, reason:"gone"} per the Task 5/6 ruling, not 404; the brief's "404" line is superseded.
Task 7: fix round 1/5 opened (1 Important: 503 before identity check)
Task 7: fix round 1/5 (1 addressed, 0 open — identity check now precedes the 503; commits 649b0d3..03d895c)
Task 7: minor (deferred): watch error responses carry CORS headers via the shared catch when an allowed Origin is present.
Task 7: minor (deferred): no regression test for the /api/watch prefix boundary (/api/watch/../sessions etc.).
Task 7: minor (deferred): weather: no lat/lon range check, no fetch timeout, expired cache entries never evicted; module-level WeakMap cache.
Task 7: minor (deferred): pathname parsed twice in server.ts; rejection log includes full req.url (lat/lon for weather).
Task 7: minor (deferred): long-poll tests leave a 2 s race timer running; 500 ms registration wait could flake under load.
Task 7: complete (commits 1224dfe..03d895c, review clean after 1 fix round, 1 ruling)
Task 8: dispatched (BASE 03d895c, implementer sonnet)
Task 8: ⚠️ resolved — exact Content-Disposition form of the real Index client unknown until hardware; hardened in Task 9 (ruling below). Reported 232 pass accepted.
Task 8: Ruling: reviewer minors #1 and #2 (param regex rejects bare/whitespaced `name=`; boundary regex unanchored) are interop risks with a client we cannot test until plan 3; Task 9 fixes both with tests. — costs: a few lines if the client already sends quoted params.
Task 8: minor (deferred): transport padding after delimiters rejected; headerless-part branch unreachable; Buffer.concat copies the whole body to prepend CRLF; "Missing signature" reason reused for missing timestamp/delivery; test gaps (real boundary inside data, preamble/epilogue, empty part, timestamp forms, missing trigger).
Task 8: complete (commits 03d895c..6a25869, review clean, 1 ruling carried to Task 9)
Task 9: dispatched (BASE 6a25869, implementer sonnet)
Task 9: ⚠️ resolved — outer handler runs OPTIONS first then the webhook branch (POST only), path from the same URL parse; registry.create passes cfg.approvalMode via main.ts's factory; test-order dependence noted as a deferred minor.
Task 9: Ruling: reviewer minor #3 (optional `replays` dep silently disables replay protection) and #2 (unbounded transcription) are cheap hardening on a network-facing path; fixed in round 1 with the Important. — costs: none.
Task 9: fix round 1/5 opened (1 Important: no_match/kept_audio not logged; + 2 ruled-in minors)
Task 9: fix round 1/5 (3 addressed, 0 open — outcome log lines, replays required, 8000-char cap; commits 0a66c36..a6c806a)
Task 9: minor (deferred): 413 test cannot fail on status (.catch maps any error to 413).
Task 9: minor (deferred): auth-order test doesn't show identity precedes signature (no-login + bad-sig → 403 case missing).
Task 9: minor (deferred): a session orphaned if prompt throws after registry.create (sidecar lacks sessionId); sanitised/long delivery ids can collide (append a hash); sync fs writes on the event loop; route tests share state and depend on order; prune test relies on mtime after a 10 ms sleep; 8000-char cut may split a surrogate pair.
Task 9: complete (commits 6a25869..a6c806a, review clean after 1 fix round, 1 ruling)
Task 10: dispatched (BASE a6c806a, implementer sonnet)
Task 10: ⚠️ resolved — WatchService's constructor only reads the session index (no pi spawn); the implementer's smoke run showed the startup line and watch.json at mode 600; app 96/96, hub 246/246 accepted.
Task 10: minor (deferred): settings "watch" section shows "This hub predates watch support" while health is loading or unreachable; needs a loading/error state.
Task 10: minor (deferred): health not re-fetched after saving a new hub URL on the same page; copy() has a redundant firstChild guard.
Task 10: complete (commits a6c806a..7d64eb8, review clean)
Task 11: dispatched (BASE 7d64eb8, implementer sonnet)
Task 11: minor (deferred): docs: sidecar not written on parse failure or test events (unstated); Host wording omits X-Forwarded-Host; uuidgen assumed; "while an app is open on a session" is loose (gate is global).
Task 11: complete (commits 7d64eb8..80b04f3, review clean)
All tasks complete. Final whole-branch review dispatched (opus) over a46518e..80b04f3.
Final review (opus, a46518e..80b04f3): ready with fixes. 1 Important (punctuated/capitalised transcripts never match: plan defect in Task 4's table), 8 minors; triage done in its report.
Final review: Ruling: declined-to-judge items accepted as spec-level: ring with an app open starts a new session (global viewer gate); hidden/dismissed requests remain answerable; watch may prompt/set model on bridge sessions listed in sessions(). None changed.
Final fix wave dispatched (sonnet): Important #1 + minors 1-7 + Task 7 prefix-boundary test.
Final fix wave: 9/9 addressed (commit d7ea588), re-review clean. Branch feat/pebble-watch complete at d7ea588.
