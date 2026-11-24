# Session Search — Plan 1 of 2: hub index, API and pi tool

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hub indexes every session's conversation text (keyword + embeddings), answers `GET /api/search`, serves the same on the internal API, and pi gets a `search_sessions` tool.

**Architecture:** A `hub/src/search/` module: `chunks.ts` turns a session file's active branch into chunks with ordinals; `db.ts` keeps them in SQLite (`node:sqlite`, FTS5) with embedding blobs; `embedder.ts` wraps transformers.js (and a deterministic hash embedder for tests); `rank.ts` fuses BM25 and cosine with RRF and cuts snippets; `service.ts` ties them together (sweep, dirty files, query); `worker.ts`/`client.ts` run the service in a worker thread. `server.ts` and `internal-server.ts` gain a route; the bridge gains the tool.

**Tech Stack:** Node 26 `node:sqlite` (FTS5, verified), `worker_threads`, `@huggingface/transformers@3.8.1` (`Xenova/bge-small-en-v1.5`, q8, CLS pooling, normalized), node:test in hub/bridge.

**Spec:** `docs/superpowers/specs/2026-11-23-session-search-design.md`

## Global Constraints

- Only new dependency: `@huggingface/transformers` pinned `3.8.1` in `hub/package.json`. No sqlite packages; `node:sqlite` only.
- Index only `message` entries with role `user` or `assistant` on the **active branch** (`branchEntries`), text blocks only; strip attachment blocks (`parseAttachments`) and the TL;DR line (`stripTldr`); no thinking, tool calls, tool results, system.
- `ordinal` = index among user/assistant messages in `historyFromText` order (which excludes `system` only). Every such message gets an ordinal even with no chunk. Chunk text ≤ 1200 chars, split on paragraph boundaries, same ordinal, `piece` counts up.
- Model cache dir: `<dataDir>/models`. Never touch `~/.cache/huggingface`.
- The hub must serve everything else while indexing: parse/embed in the worker thread; the main thread only forwards messages.
- Keyword search must work when embeddings are missing; the response carries `semantic: boolean`.
- API: `GET /api/search?q=<text>&limit=<n>` (default 8, max 20) → `SearchResponse`; internal API `GET /search?q=&limit=&exclude=<sessionId>` → same. `q` shorter than 2 characters after trim → `{ hits: [], semantic }` with 200.
- Tailnet identity only on the public route (existing CORS/origin checks); no tokens.
- All shared shapes live in `shared/src/protocol.ts`.
- Commits end with a blank line and `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A query of punctuation or stopwords only (`"the"`, `"??"`) must return no hits and never throw from FTS5 syntax (Task 5 test `query: punctuation and stopwords give no hits`).
2. A session file deleted after indexing must not surface as a hit (Task 5 `sweep purges a vanished file`).
3. A single 50 000-character message must index as pieces without a stack or FTS error and search within it (Task 1 `long message splits into pieces`).
4. A query with diacritics (`"café"`) matches `cafe` and vice versa (Task 2 `fts: diacritics fold`).
5. The running session's newest turn is findable within seconds of pi finishing it (Task 6 `poke re-indexes a changed file`).

---

### Task 1: Chunking a session file

**Files:**
- Create: `hub/src/search/chunks.ts`
- Test: `hub/test/search-chunks.test.ts`
- Fixture: `hub/test/fixtures/search/forked.jsonl` (create: a session with user/assistant messages, a fork (two children of one parent, the later one active), an assistant message with only a toolCall block, a user message with an attachments block + inlined file, an assistant text ending in a TL;DR line, one message > 3000 chars with blank lines)

**Interfaces:**
- Consumes: `branchEntries`, `historyFromText` from `shared/src/session-file.ts`; `parseAttachments`, `summarizeAttachments` from `shared/src/attachments.ts`; `stripTldr` from `shared/src/tldr.ts`.
- Produces:
  ```ts
  export const MAX_CHUNK = 1200;
  export interface Chunk { ordinal: number; piece: number; role: "user" | "assistant"; ts: number; text: string }
  export interface ChunkedSession { sessionId: string; cwd: string; chunks: Chunk[] }
  export function chunkSession(text: string): ChunkedSession | null; // null when the header is not a session
  export function messageText(m: AgentMessage): string; // text blocks joined by "\n", attachments stripped to "[file: name]" markers, TL;DR stripped for assistant
  export function splitText(text: string, max?: number): string[]; // paragraph-boundary split, each ≤ max
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("ordinals follow the active branch and count every user/assistant message", () => {
	const text = readFileSync(FIXTURE, "utf8");
	const chunked = chunkSession(text)!;
	const history = historyFromText(text).filter((m) => m.role === "user" || m.role === "assistant");
	for (const c of chunked.chunks) assert.equal(messageText(history[c.ordinal]).includes(c.text.slice(0, 40)), true);
	assert.equal(Math.max(...chunked.chunks.map((c) => c.ordinal)) < history.length, true);
	assert.equal(chunked.chunks.some((c) => c.text.includes("ABANDONED BRANCH")), false);
});
test("tool-call-only assistant turns take an ordinal but no chunk", () => { /* the ordinal after the toolCall-only message is +2 from the one before */ });
test("attachments and inlined files are stripped; a files-only message keeps a marker", () => { /* text has "[file: notes.md]" and not the inlined body */ });
test("the TL;DR line is not indexed", () => { /* no chunk text ends with the TL;DR summary */ });
test("long message splits into pieces", () => { /* 50_000-char message → pieces all ≤ 1200, same ordinal, piece 0..n, concatenation covers the text */ });
test("a non-session file returns null", () => { assert.equal(chunkSession("{}\n"), null); });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub && node --test test/search-chunks.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `chunks.ts`**

`chunkSession` reads the header (`type: "session"`), walks `branchEntries(text)`, keeps `message` entries with role user/assistant, counts the ordinal over those (system is already excluded by `historyFromText`; match its filter exactly: it drops role `system` only). `messageText`: string content → one block; blocks of `type: "text"` joined; user → `parseAttachments` and replace with `text + " " + files.map(f => "[file: " + f.name + "]")` (images in content → `[image]`); assistant → `stripTldr`. `splitText`: split on `\n\n`, pack paragraphs greedily up to `max`, hard-split a paragraph longer than `max` at the last space before `max`.

- [ ] **Step 4: Run to verify pass**; **Step 5: Commit** `feat(hub): chunk a session's active branch for search`

---

### Task 2: The search database

**Files:**
- Create: `hub/src/search/db.ts`
- Test: `hub/test/search-db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ChunkRow extends Chunk { id: number; sessionId: string; file: string; hasEmbedding: boolean }
  export class SearchDb {
    constructor(file: string); // ":memory:" allowed; opens WAL; creates tables + FTS5 + triggers if missing
    files(): Map<string, { sessionId: string; mtimeMs: number; size: number }>;
    replaceFile(file: string, sessionId: string, cwd: string, mtimeMs: number, size: number, chunks: Chunk[]): void; // one transaction
    removeFile(file: string): void;
    keyword(query: string, limit: number): { id: number; score: number }[]; // bm25, lower is better → returned as positive descending score
    pendingEmbeddings(limit: number): { id: number; text: string }[];
    setEmbeddings(rows: { id: number; vec: Float32Array }[]): void;
    allEmbeddings(): { id: number; vec: Float32Array }[];
    chunks(ids: number[]): ChunkRow[];
    sessionOf(id: number): string;
    stats(): { files: number; chunks: number; embedded: number };
    close(): void;
  }
  export function ftsQuery(q: string): string | null; // user text → FTS5 MATCH string (quoted terms ANDed, prefix on the last term); null when no term survives
  ```
- Schema: `files(file PRIMARY KEY, session_id, cwd, mtime_ms, size, indexed_at)`; `chunks(id INTEGER PRIMARY KEY, session_id, file, ordinal, piece, role, ts, text, embedding BLOB)` + index `(session_id)` + index `(file)`; `chunks_fts` FTS5 `(text, content='chunks', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2')` with insert/delete/update triggers.

- [ ] **Step 1: Failing tests**

```ts
test("replaceFile stores chunks and keyword finds them with stemming", () => { /* insert "we restarted the hubs" → keyword("restart hub") hits */ });
test("fts: diacritics fold", () => { /* "café" finds "cafe" and "cafe" finds "café" */ });
test("ftsQuery escapes punctuation and returns null for nothing usable", () => { assert.equal(ftsQuery("??"), null); assert.equal(ftsQuery('tk-shell "aside'), '"tk" "shell" "aside"*'); });
test("replaceFile replaces, removeFile purges, files() reflects both", () => {});
test("embeddings: pending → set → all round-trips Float32Array", () => {});
test("keyword returns nothing while the table is empty and never throws on odd input", () => { for (const q of ["", "*", "(", "the"]) assert.doesNotThrow(() => db.keyword(q, 5)); });
```

- [ ] **Step 2: Run to verify failure** — `cd hub && node --test test/search-db.test.ts` FAIL.
- [ ] **Step 3: Implement `db.ts`** with `DatabaseSync` from `node:sqlite`; `ftsQuery` tokenizes on non-letter/digit (keep letters with diacritics), lowercases, drops empty, quotes each, adds `*` to the last; `keyword` runs `SELECT rowid, bm25(chunks_fts) AS r FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY r LIMIT ?` and maps `score = -r`; when ANDed yields 0 rows and there are ≥ 2 terms, retry with `OR`.
- [ ] **Step 4: Run to verify pass**; **Step 5: Commit** `feat(hub): sqlite search store with fts5`

---

### Task 3: Embedders

**Files:**
- Create: `hub/src/search/embedder.ts`
- Test: `hub/test/search-embedder.test.ts`
- Modify: `hub/package.json` (add `"@huggingface/transformers": "3.8.1"` to dependencies; run `npm install` at the repo root)

**Interfaces:**
- Produces:
  ```ts
  export interface Embedder { readonly name: string; readonly dims: number; embed(texts: string[]): Promise<Float32Array[]> } // normalized vectors
  export function hashEmbedder(dims = 384): Embedder; // deterministic: tokens hashed into dims, l2-normalized; same text → same vector; shared words → positive cosine
  export function transformersEmbedder(cacheDir: string, log: (m: string) => void): Embedder; // lazy: loads "Xenova/bge-small-en-v1.5" q8 on first embed; env.cacheDir = cacheDir; pooling "cls", normalize true; a load failure rejects embed() and is retried on the next call no sooner than 60 min later
  export function cosine(a: Float32Array, b: Float32Array): number;
  ```

- [ ] **Step 1: Failing tests** — `hashEmbedder: deterministic, normalized, shares words → higher cosine than unrelated`; `transformersEmbedder: constructing it loads nothing` (no file under a temp cacheDir after construction); an opt-in `PI_WEB_REAL_EMBEDDER=1` test that embeds two sentences and asserts dims 384 and a sensible ranking (skipped otherwise).
- [ ] **Step 2: Run to verify failure**; **Step 3: Implement**; **Step 4: Run to verify pass** (`cd hub && node --test test/search-embedder.test.ts`; also `npm run typecheck -w hub`).
- [ ] **Step 5: Commit** `feat(hub): search embedders (transformers.js + deterministic hash)`

---

### Task 4: Ranking and snippets

**Files:**
- Create: `hub/src/search/rank.ts`
- Test: `hub/test/search-rank.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function rrf(lists: { id: number }[][], k = 60): { id: number; score: number }[]; // descending
  export function cosineTopK(query: Float32Array, rows: { id: number; vec: Float32Array }[], k: number): { id: number; score: number }[];
  export function queryWords(q: string): string[]; // lowercased letter/digit runs, ≥ 2 chars
  export function termsIn(text: string, words: string[]): string[]; // surface forms in text whose lowercase starts with a query word (dedup, in text order)
  export function snippet(text: string, words: string[], max = 220): string; // window around the first term match (else the start), on word boundaries, "…" at cut ends
  ```

- [ ] **Step 1: Failing tests** — rrf merges two lists with the expected order and tie handling; cosineTopK returns k best; termsIn maps stems back (`"restart"` → `"restarted"`); snippet windows around the match and keeps ≤ max; snippet with no match starts at 0 without a leading ellipsis.
- [ ] **Step 2: Run to verify failure**; **Step 3: Implement**; **Step 4: Run to verify pass**; **Step 5: Commit** `feat(hub): rrf fusion, terms and snippets for search`

---

### Task 5: The search service (sweep, dirty files, query)

**Files:**
- Create: `hub/src/search/service.ts`
- Test: `hub/test/search-service.test.ts` (uses a temp sessions dir with real session files written by the test, `hashEmbedder`, `SearchDb(":memory:")`)

**Interfaces:**
- Consumes: Tasks 1–4; `SessionIndex`-like listing: `lookup: () => Promise<{ id: string; file: string; cwd: string; name: string | null; firstPrompt: string | null; updatedAt: number; parentSession: string | null }[]>`.
- Produces:
  ```ts
  export interface RawHit { sessionId: string; ordinal: number; role: "user" | "assistant"; snippet: string; terms: string[]; semanticOnly: boolean; score: number }
  export interface SearchServiceOptions { db: SearchDb; embedder: Embedder | null; lookup: ...; log?: (m: string) => void; embedBatch?: number /* 32 */ }
  export class SearchService {
    constructor(opts: SearchServiceOptions);
    sweep(): Promise<{ indexed: number; removed: number }>; // stat every listed file; re-chunk changed/new (mtime or size differs from db.files()), remove vanished; then embedPending()
    embedPending(): Promise<number>; // newest files first; returns count embedded; no-op without an embedder
    poke(): void; // schedules a sweep in 2 s (debounced)
    query(q: string, limit: number, exclude?: string): Promise<{ hits: RawHit[]; semantic: boolean }>;
    stats(): { files: number; chunks: number; embedded: number; semantic: boolean };
  }
  ```
- Query algorithm (spec): keyword top 40 via `db.keyword(ftsQuery(q))`; if embedder and ≥ 1 embedded chunk: embed q, `cosineTopK` over `db.allEmbeddings()` (cached in memory, invalidated by `setEmbeddings`/`replaceFile`), top 40; `rrf`; group by session keeping the best chunk; drop `exclude`; drop sessions not in the latest `lookup()`; take `limit`; `semanticOnly` = not in the keyword list; `semantic` = whether the vector list was used.

- [ ] **Step 1: Failing tests**

```ts
test("sweep indexes new files, skips unchanged, re-indexes changed, purges vanished", ...);
test("sweep purges a vanished file", ...); // a hit disappears after unlink + sweep
test("query: keyword-only works before any embedding (semantic false)", ...);
test("query: fused ranking groups per session and marks semanticOnly", ...);
test("query: punctuation and stopwords give no hits", ...); // "??", "the" → [] without throwing
test("query: exclude drops the current session", ...);
test("poke re-indexes a changed file", async () => { /* append a message to a file, poke(), wait ≤ 3 s, query finds it */ });
```

- [ ] **Step 2: Run to verify failure**; **Step 3: Implement**; **Step 4: Run to verify pass** (`cd hub && node --test test/search-service.test.ts`); **Step 5: Commit** `feat(hub): search service: sweep, poke, fused query`

---

### Task 6: Worker thread, config, hub routes, wiring

**Files:**
- Create: `hub/src/search/worker.ts` (runs a `SearchService` from `workerData: { dbFile, cacheDir, embedder: "transformers" | "hash" | "none", sessionsDir }`, answers `{ id, op: "query" | "stats" | "poke" | "sweep", ... }` messages), `hub/src/search/client.ts` (`class SearchClient { constructor(opts); query(q, limit, exclude?): Promise<{hits, semantic}>; poke(): void; stats(): Promise<...>; close(): Promise<void> }` over `worker_threads`, with a 5 s per-call timeout that rejects)
- Modify: `shared/src/protocol.ts` (add `SearchHit`, `SearchResponse` below), `hub/src/server.ts` (`HubDeps.search?: Pick<SearchClient, "query">`; route `GET /api/search`), `hub/src/internal-server.ts` (`InternalDeps.search?`; route `GET /search` with `exclude`), `hub/src/main.ts` (create `SearchClient` with `dbFile: join(cfg.dataDir, "search.db")`, `cacheDir: join(cfg.dataDir, "models")`, embedder from `process.env.PI_WEB_SEARCH_EMBEDDER ?? "transformers"`; `registry.onChange((m) => m.type === "session_state" && m.state !== "running" && search.poke())`; also `search.poke()` on `session_list_changed`; pass to both servers; close on shutdown), `hub/src/rpc-handle.ts:268` (child env gains `PI_WEB_INTERNAL_PORT: String(internalPort)` and `PI_WEB_APP_ORIGIN` — thread both through `RpcHandleOptions` from `main.ts`: `cfg.internalPort`, `cfg.allowedOrigins[0]`)
- Test: `hub/test/search-routes.test.ts` (hub server built like `hub/test/progress-routes.test.ts`, with a fake `search` dep), `hub/test/search-client.test.ts` (real worker with `embedder: "hash"` on a temp dir: sweep, query, close)

**Interfaces (shared):**
```ts
export interface SearchHit { sessionId: string; type: SessionType; name: string | null; firstPrompt: string | null; cwd: string; updatedAt: number; ordinal: number; role: "user" | "assistant"; snippet: string; terms: string[]; semanticOnly: boolean }
export interface SearchResponse { hits: SearchHit[]; semantic: boolean }
```
The route composes `RawHit` + the listing (`listSessions()` in server.ts already has `type` via `registry.typeOf`) into `SearchHit`; `limit` clamps to [1, 20]; `q.trim().length < 2` → `{ hits: [], semantic }`; no `search` dep → 404 `{ error: "search is not available" }`.

- [ ] **Step 1: Failing tests** — routes: 200 shape with `type` from the registry, short q → empty, limit clamp, 404 without the dep, internal route passes `exclude`; client: worker round trip, `poke` then query finds a new file, `close` resolves.
- [ ] **Step 2: Run to verify failure**; **Step 3: Implement**; **Step 4: Run to verify pass** (`cd hub && node --test test/search-routes.test.ts test/search-client.test.ts`; `npm run typecheck -w hub -w shared`); **Step 5: Commit** `feat(hub): /api/search, internal /search, search worker wired at start`

---

### Task 7: The `search_sessions` pi tool and chat.md

**Files:**
- Create: `bridge/search-tool.ts`
- Modify: `bridge/index.ts` (register it beside `show_image`, before the `PI_WEB` check so hub children and terminal pis both get it), `hub/prompts/chat.md` (one line in the tools section: "When asked about something discussed before, call `search_sessions` before answering from memory."), `hub/test/rpc-handle.test.ts` (the existing chat.md assertions gain one: the prompt names `search_sessions`)
- Test: `bridge/test/search-tool.test.ts`

**Interfaces:**
```ts
export interface SearchToolDeps { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv; currentSessionId?: () => string | null }
export function registerSearchTool(pi: { registerTool(t: any): void }, deps?: SearchToolDeps): void; // name "search_sessions", params { query: string; limit?: number (1–8, default 5) }
export function formatHits(hits: SearchHit[], appOrigin: string | null): string; // one block per hit: "N. <title> · <code|chat> · <date> · <cwd>\n   <you|pi>: <snippet>\n   <appOrigin>/#/s/<id>/at/<ordinal>" (or "#/s/…" when no origin); "No past conversation matches." when empty
```
Base URL: `http://127.0.0.1:${env.PI_WEB_INTERNAL_PORT ?? "7879"}/search?q=…&limit=…&exclude=<current>`; `appOrigin` from `env.PI_WEB_APP_ORIGIN ?? null`; title = `name ?? firstPrompt ?? sessionId`; a fetch error returns the text "Session search isn't available right now (the hub didn't answer)." rather than throwing.

- [ ] **Step 1: Failing tests** — `formatHits` renders the block and the link; the tool calls the internal URL with `exclude` and `limit` and returns the formatted text; hub down → the friendly line; chat.md names the tool.
- [ ] **Step 2: Run to verify failure**; **Step 3: Implement**; **Step 4: Run to verify pass** (`cd bridge && node --test test/search-tool.test.ts`; `cd hub && node --test test/chat-prompt.test.ts`; `npm run typecheck -w bridge`); **Step 5: Commit** `feat(bridge): search_sessions tool; chat.md points at it`

---

### Task 8: Real-model smoke and repo-wide checks

- [ ] **Step 1:** `PI_WEB_REAL_EMBEDDER=1 cd hub && node --test test/search-embedder.test.ts` — Expected: the opt-in test passes (downloads the model into a temp cacheDir; ~100 MB).
- [ ] **Step 2:** Start the hub from the worktree against a copy of 20 real session files in a temp sessions dir (`PI_CODING_AGENT_SESSION_DIR=<tmp>`, which `sessionsDir()` honours; a spare `dataDir` via `loadConfig`'s default is fine, or point `PI_WEB_DATA_DIR` at a temp dir if config supports it; port must not be 7878, the live hub) and time `curl 'http://127.0.0.1:<port>/api/search?q=preview%20tailscale'` three times warm. Expected: under 150 ms each; the hub log shows the sweep and embedding counts. Stop that hub afterwards.
- [ ] **Step 3:** `npm run typecheck && npm run test` at the repo root — Expected: all green.
- [ ] **Step 4:** Commit nothing (verification only); note timings in the task report.
