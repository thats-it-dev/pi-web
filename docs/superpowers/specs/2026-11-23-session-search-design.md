# Session search: find a past conversation by topic

**Date:** 2026-11-23 · **Owner:** Michael · **Status:** approved design, awaiting plan

## Intent

Michael wants to find something he and pi discussed before ("the watch battery thing", "where did we settle the preview ports") without remembering which session it was in. Today the sessions panel's search box only matches a session's name, first prompt and folder; nothing looks inside conversations. This adds search inside past conversations for both session types, from the sessions panel and from pi itself.

## Michael's decisions (verbatim or near)

- "its search for an existing chat session based on keywords or topics. like if i want to go back and find something we discussed previously."
- "should probably be RAG based" → matching is **keywords + meaning**: full-text search plus embedding similarity, fused into one ranking.
- Result shape: **sessions with the matching passage**; tapping opens the session **scrolled to that message**.
- Lives in **the sidebar search box**, upgraded; title matches stay instant, topic matches arrive after a pause **as you type (~300 ms of no typing)**.
- Indexed text: **Michael's messages and pi's replies** only. Not tool output, not thinking.
- Scope: **search both types regardless of the code/chat toggle**; each hit shows its type.
- **The search field is hidden until a search icon in the top bar is tapped; while open, the field replaces the whole top row** (brand, toggle, gear). X, Escape, or clearing the field closes it.
- **pi also gets a tool** to search past sessions ("where did we talk about X?"), in chat and code sessions.
- Mockup approved: https://claude.ai/artifact/PWxeuwpdjEtejQuGqAjeog (kept in `.superpowers/brainstorm/` too).

## Goals

1. A topic typed in the panel returns the right past session in the top few hits, with the passage that matched, in well under a second on the spark.
2. One tap lands on the matched message.
3. pi can answer "did we talk about X?" with quotes and links to the sessions.
4. Nothing new to run or babysit: the hub owns the index; no GPU, no llama-swap change, no extra service.

## Non-goals

- Searching tool output, thinking, or file contents (later, if ever; the index design leaves room).
- Searching across machines or other users. One hub, one person.
- A separate search page or filters (date, folder, model). The panel is the UI.
- Replacing the title filter. It stays as it is and stays instant.

## Anti-goals (would make this a failure)

- Search that blocks or slows the hub's normal work (session streams, listing) while indexing.
- A hit that opens the wrong session or the wrong place in it.
- Results that silently miss recent conversation because the index lags by minutes.
- A model download or embedding failure that takes search down entirely. Keyword search must still work.

## Constraints and facts from recon

- Corpus today: 169 sessions, ~11.5k user+assistant messages, ~1.1 M characters of conversation text (tool output is ~16 M and is excluded). Small enough for brute-force vector search for years.
- The hub runs on Node 26 (`~/.local/bin/node`), whose built-in `node:sqlite` has FTS5 (verified). No native build needed.
- llama-swap serves no embedding model and every model group is exclusive; an embedding model there could unload the active model. So embeddings run **on the CPU inside the hub** with transformers.js (verified spike on this arm64 box: `Xenova/bge-small-en-v1.5` q8 loads in ~7 s, embeds a query in a few ms, ranks sensibly).
- The HF cache dir under `~/.cache/huggingface/hub` is root-owned; the hub keeps its model under its own data dir instead. Hugging Face is reachable from the spark.
- Session files are JSONL under `~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl`; `hub/src/sessions.ts` already walks them and caches by mtime+size (`SessionIndex`). Message entries have `type: "message"`, `message.role` in `user | assistant | toolResult | system`, `content` as a string or blocks (`text`, `thinking`, `toolCall`, images…). Entries carry an `id`.
- The app's conversation has no message ids today; `AgentMessage` is role/content/timestamp. A jump target therefore needs a position, and the hub and the app must count messages the same way (see "Jump target").
- Hub API is tailnet-identity only (no tokens; Michael's standing decision). The hub also has an internal API on 127.0.0.1:7879 that extensions use.
- Session types shipped today (PR #15): `SessionSummary.type`, `registry.typeOf(id, parentSession)`; results reuse it.

## The experience

### Opening search

The sessions panel header is: brand, type toggle, **search icon** (Lucide `search`), gear. Tapping the icon swaps the whole top row for the search field (full width, focused, with an X at its right). On a phone this happens inside the drawer. The X, Escape, or emptying the field and tapping X closes search and restores the top row; the list returns to plain history. The field's text is kept per tab only while open.

### Typing

- Every keystroke filters the list by title/first prompt/folder as today (instant, client side), still grouped by date, still limited to the selected type.
- After ~300 ms with no typing and at least 2 characters, the app asks the hub for topic hits. While waiting, a small pulse row says "searching…" under the list. Results replace it under a label **"In conversations"**. Up to 8 hits.
- A session may appear both in the title list and as a hit; neither is removed.
- Empty states: no title matches → "No session titles match." (the hit section still comes); no hits → "Nothing in conversations." ; hub unreachable → the hit section says so briefly and the title filter keeps working.
- Query changes cancel the in-flight request (abort) so stale hits never land over newer ones.

### A hit (row anatomy, as mocked)

Grid like a list row: the **type icon** (code `<>` or chat bubble, 12 px, muted) in the dot column; **title** and **age**; then the **passage**, two lines, clamped, with matched words underlined in amber (bold, no background); then a footer line **"you" or "pi" · folder**. A purely semantic hit has no words to underline; the footer then reads "topic match". Rows are links.

### Tapping a hit

Opens the session (route below). Once the conversation has rendered, the view scrolls the target message into view (centered) and paints an amber wash on its left edge that fades over ~3 s. If the target can't be found (e.g. the session was compacted or rewritten), the session opens at the top with no error.

### pi tool

`search_sessions({ query, limit? })` in the pi-web bridge extension (the same extension that provides `show_image` and `preview`), available in chat and code sessions started by the hub. It calls the hub's internal API, excludes the current session, and returns up to 8 hits as text: title, type, date, folder, who said it, the passage, and a link `#/s/<id>/at/<n>` that pi-web renders as a tappable link in the reply (plain text in a terminal). `hub/prompts/chat.md` gains one line: when asked about something discussed before, use `search_sessions` before guessing. Code sessions discover it through the tool description.

## The index (hub)

### Storage

`<dataDir>/search.db` (SQLite via `node:sqlite`, WAL). Tables:

- `files(file PRIMARY KEY, session_id, mtime_ms, size, indexed_at)`
- `chunks(id INTEGER PRIMARY KEY, session_id, file, ordinal, piece, role, ts, text, embedding BLOB NULL)` with an index on `(session_id)`
- `chunks_fts` — FTS5 external-content table over `chunks.text` (tokenizer `unicode61 remove_diacritics 2`, with `porter` stemming), kept in step by triggers.

`embedding` is a little-endian Float32 array (384 dims for bge-small). NULL until embedded, so keyword search works before the model is ready.

### What becomes a chunk

For each `message` entry with role `user` or `assistant`, the text is the concatenation of its `text` blocks (a string content counts as one text block). Thinking, tool calls, tool results, system prompts, attachments' bytes: skipped. Attachments are summarized the same way `summarize()` does for `firstPrompt` (`[image]`, file names), so a message that was only an attachment still has a line. Empty text → no chunk. Text longer than ~1200 characters is split on paragraph boundaries into pieces ≤ 1200 chars that share the message's `ordinal` and count up `piece`.

`ordinal` is the message's position among user/assistant messages, counting from 0, over the **same message list the app renders** (see Jump target). Session files are trees (forks and rewinds leave abandoned branches in the file); the indexer walks the **active branch only**, with the same `branchEntries`/`historyFromText` walk the app's history comes from, so the ordinal matches by construction. Abandoned-branch text is not searchable; a fork copies its entries into the child, so what was kept stays findable.

Every user/assistant message on the branch takes an ordinal, including ones that produce no chunk (a tool-call-only assistant turn, an empty text). The app tags each rendered message with its ordinal (a data attribute) rather than counting elements, so the two sides cannot drift.

User messages carry inlined attachment blocks (the app parses them back out with `parseAttachments`); the indexer strips them the same way and indexes `[file: name]` / `[image]` markers plus the typed text, so search never matches inside a pasted file. The assistant's closing TL;DR line, which the UI strips, is not indexed either: a snippet must show text the person can see in the session.

### Keeping it fresh

- At hub start: a sweep in a worker thread compares every session file's mtime+size with `files`; changed or new files are re-chunked (delete that file's chunks, insert fresh), vanished files are purged. First run on today's corpus should finish in about a minute including embeddings; the hub serves everything else meanwhile.
- While running: the hub already notices session file changes when it lists sessions (`SessionIndex` cache) and already sees each rpc child's turn end. Either signal marks the file dirty; a debounced (~2 s) re-index of dirty files runs in the worker. A hit can therefore point at a message from the current conversation a few seconds after pi finished it.
- Embedding runs in the same worker, in batches, newest files first, so the keyword index is complete before the vectors catch up. The response to a query says whether semantic ranking was available (`semantic: true|false`) so the UI can label a keyword-only result set.
- Vectors are kept in memory in the worker (Float32Array per chunk, ~17 MB at 11.5k chunks) and reloaded from the DB at start.

### The model

`Xenova/bge-small-en-v1.5`, `dtype: "q8"`, through `@huggingface/transformers` (pinned), with `env.cacheDir = <dataDir>/models` and `env.allowRemoteModels` true only when the files are missing. CLS pooling, normalized. Queries are embedded with the same model; bge-small needs no instruction prefix for symmetric short-text use. If the model cannot load (offline first start, broken download), the worker logs once, keeps keyword search, and retries loading hourly.

### Answering a query

`GET /api/search?q=<text>&limit=8` (tailnet, like every other route) and the same on the internal API for the tool. Steps:

1. FTS5: `bm25()` over `chunks_fts` for the query (terms ANDed; if that yields nothing, OR), top 40 chunks.
2. Vector: cosine over all embedded chunks against the query embedding, top 40.
3. Fuse with reciprocal rank fusion (k = 60).
4. Group by `session_id`, keep each session's best chunk, drop chunks from sessions that no longer list (deleted), take the top `limit`.
5. For each: `{ sessionId, type, title, cwd, updatedAt, ordinal, role, snippet, terms, semanticOnly }` where `title` is the listing's name/first prompt, `type` comes from `registry.typeOf`, `snippet` is ≤ 220 characters windowed around the first keyword match (or the chunk start), `terms` are the query words found in the chunk (after stemming, mapped back to surface forms for underlining).

Target: under 150 ms warm for the corpus today, under 500 ms at ten times the size.

## Jump target

Route: `#/s/<id>/at/<n>` where `n` is the ordinal above. `parseRoute` learns it; `hrefFor` emits it. The session route without `/at/` is unchanged.

The app renders the conversation from the hub's snapshot/history, which is built by `historyFromText` from the same file (active branch). The design pins **ordinal = index among messages with role user or assistant on the active branch, as `historyFromText` returns them**. The plan's first task adds a unit test that the indexer's ordinal of a fixture message equals its index in `historyFromText(fixture)` filtered to those roles, on a fixture with a fork. If pi's compaction or a rewind rewrites a file, the file's mtime changes and the index is rebuilt, so ordinals stay in step with what the app shows.

`pi-session` scrolls when: the route has `at`, the snapshot has loaded, and a rendered message with that ordinal exists in `conv.messages` at that moment. It uses `scrollIntoView({ block: "center" })`, adds a class that paints the wash, and removes the `at` segment from the hash (replaceState) so a reload stays put. Messages that stream in afterwards don't move the target (they append). If the ordinal is missing, the session opens at the top with no error. Respects `prefers-reduced-motion` (no fade, just the border).

## Session types, rollout, skew

- Both types are indexed and searched. Hits carry `type` so the row shows the right icon.
- New app + old hub: `/api/search` returns 404; the app shows the title filter only and no hit section (no error toast). Old app + new hub: nothing changes.
- First deploy: the hub restarts, the worker indexes everything in the background; search works with keywords within seconds and with meaning within about a minute.
- The index is derived data: deleting `search.db` is always safe.

## Testing (what the plan must cover)

- Hub unit: chunking (string vs blocks, thinking/tool skipped, long split, ordinal/piece), ordinal agreement with `historyFromText`, FTS matching with stemming, RRF fusion order, snippet windowing and terms, incremental re-index on mtime change and purge on delete, keyword-only answers while `embedding` is NULL.
- Hub integration: `/api/search` end to end with a **fake embedder** (deterministic hashing into 384 dims) injected in tests so no model downloads; the real model is exercised by one opt-in test behind an env flag.
- App unit: route parse/emit for `/at/<n>`, debounce/abort logic, hit row rendering (terms underlined, semantic-only footer), search-open state of the header (field replaces the row, X/Escape/clear closes).
- Playwright (fake hub + fake embedder): type a topic → hits appear under the list; tap → session opens scrolled with the target highlighted; phone drawer variant; old-hub 404 degrades quietly; look snapshots for the header at rest and open.
- Bridge: `search_sessions` tool returns formatted hits and excludes the current session.

## Left to the builder

- Worker protocol and batching; exact debounce values; the OR fallback rule; RRF k; snippet window edges; how `terms` maps stems back to surface forms (a simple prefix match on the query words is acceptable).
- Whether the hit rows live in `pi-sidebar` or a `render/search-hits.ts` module (prefer the module, like the toggle).
- The exact kit markup for the open-search top row and the icon sizes (match the mockup: 18 px icons, field full width).
- Model load retry cadence and log wording.

## Calls I made (Michael can overrule)

- bge-small-en-v1.5 over nomic/bge-m3: English-only corpus, 384 dims, fastest on CPU, strong enough for topic recall at this size.
- Hybrid ranking via RRF rather than a learned reranker: no second model, predictable, good enough for one person's corpus.
- Tool output excluded from the first version even though "the file where we changed X" would benefit; it's 15× the text and mostly noise for "what we discussed".
- Hits grouped per session (one row per session) rather than per passage; a session's other matches are reachable by opening it.
- The field replaces the top row only while open; the toggle and gear return on close (no permanent loss of the toggle).
- Active branch only (forks/rewinds): abandoned-branch text is not searchable, in exchange for jump targets that are right by construction.
- Every user/assistant message gets an ordinal even when it has no searchable text; the app tags rendered messages with it.
- Pasted-file contents inside a user message and the assistant's stripped TL;DR line are not indexed, so a snippet always shows text visible in the session.
- The jump counts over the loaded snapshot and falls back to the top when the ordinal is missing.
