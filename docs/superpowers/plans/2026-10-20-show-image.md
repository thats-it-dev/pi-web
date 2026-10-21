# Images in pi's replies: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi can show an image file in its reply in pi-web, and any image in a
session loads lazily by reference, so sessions with many images open fast.

**Architecture:** The bridge extension registers a `show_image` tool, which
returns the image as a content block (or, with `see: false`, in `details`).
On its way out to the app, the hub replaces every image's base64 with a
sha256 `ref` and serves the bytes from `GET /api/sessions/:id/images/:ref`.
The app renders refs with a `<pi-image>` element. It fetches through the
existing hub client when the image scrolls into view, and shows it from a
`blob:` URL, with a full-screen viewer on tap.

**Tech Stack:** TypeScript (Node ≥ 22.18, run directly), pi 1.0.2 extension
API with `typebox`, Lit 3.3.3, vitest 5 (app), `node --test` (shared, hub,
bridge), Playwright 1.64 (app e2e).

**Spec:** `docs/superpowers/specs/2026-10-20-show-image-design.md`

## Global Constraints

- Accepted types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`
  (the same as `app/src/lib/images.ts` `IMAGE_TYPES`). Detect them from magic
  bytes, never from the file extension.
- `show_image` file cap: 2 MB (2,000,000 bytes).
- `show_image` is registered **before** `if (process.env.PI_WEB === "1") return;`
  in `bridge/index.ts`.
- Result text and tool description say "displayed in the conversation",
  never "shown to Michael".
- The bridge gains no runtime dependencies (`typebox` is supplied by pi).
- No image bytes go from the hub to the app in SSE messages or the
  `history` response. Only the image route returns bytes.
- The rewrite works on copies. pi's messages, and the handle's in-memory
  snapshot, keep their data, so the model's context is unchanged.
- The image route sits behind the same `checkRequest` gate as every `/api`
  route, never reads a filesystem path from the request, and answers 404 for
  a ref that isn't in that session.
- Image response header: `Cache-Control: private, max-age=31536000, immutable`.
- The app adds no CSP entries. It fetches with `fetch` (`connect-src`) and
  shows the image from a `blob:` URL (`img-src blob:`).
- Images bind through Lit attributes, never `unsafeHTML`. Markdown images
  stay links.
- Commits use `git -c user.name="Michael Gutensohn" -c user.email="michael@gutensohn.me"`
  and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  Work only in the worktree `~/workspace/pi-web/.claude/worktrees/show-image`
  (branch `feat/show-image`).

## Review Focus

1. **Forks and new sessions:** the SSE stream follows a session id change
   (`server.ts` `sessionStream`, `id = msg.snapshot.sessionId`). Images in a
   forked session must still load under the new id. Test: Task 4,
   `images of a forked session load under its new id`.
2. **A session that isn't live,** opened after a hub restart: the bytes come
   from the session file. Test: Task 4, `a ref is served from the session
   file when no handle is live`.
3. **Hub versions without refs:** an app talking to a hub without refs gets
   inline `data` image blocks. The app must still show them, from a `data:`
   URL. Test: Task 6, `inline data images still render`.
4. **The same screenshot twice** in a session is fetched once. Test: Task 5,
   `two elements with one ref fetch once`.
5. **A failed fetch** (403 after a tailnet change, 404): show "image
   unavailable" and no broken-image icon. Test: Task 5, `a failed fetch
   leaves the unavailable state`.

---

### Task 1: Image helpers and the ref block type (shared)

**Files:**
- Create: `shared/src/images.ts`
- Modify: `shared/src/protocol.ts:91-95` (`ContentBlock` image variant)
- Test: `shared/test/images.test.ts`

**Interfaces:**
- Produces:
  - `export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp"`
  - `export function sniffImageType(bytes: Uint8Array): ImageMime | null`
  - `export function imageDimensions(bytes: Uint8Array, mime: ImageMime): { width: number; height: number } | null`
  - In `protocol.ts`, the image variant becomes
    `{ type: "image"; mimeType: string; data?: string; ref?: string; width?: number; height?: number }`.
    Exactly one of `data` or `ref` is set.

- [ ] **Step 1: Write the failing tests** in `shared/test/images.test.ts`,
  using tiny hand-built headers as `Uint8Array` literals:
  - `sniffs png, jpeg, gif and webp`: each returns its mime.
  - `rejects other bytes`: `%PDF-` and an empty array both return `null`.
  - `reads png dimensions`: the IHDR width/height at bytes 16–23 give
    `{ width: 200, height: 228 }`.
  - `reads gif and webp dimensions`: GIF logical screen size; WebP `VP8X`,
    `VP8 ` and `VP8L` chunks.
  - `reads jpeg dimensions from the first SOF marker`, skipping an APP0
    segment first.
  - `returns null for a truncated header`.
- [ ] **Step 2:** Run `npm run test -w shared`. Expected: FAIL, the module
  isn't found.
- [ ] **Step 3:** Implement both functions. No dependencies. Must stay
  browser-safe (`Uint8Array`, `DataView`; no `Buffer`).
- [ ] **Step 4:** Update the `ContentBlock` image variant.
  `shared/src/reducer.ts` `contentText` already skips images, so its tests
  still pass.
- [ ] **Step 5:** Run `npm run test -w shared && npm run typecheck`.
  Expected: PASS.
- [ ] **Step 6: Commit** with `feat(shared): sniff image type and size; image blocks can carry a ref`.

### Task 2: The `show_image` tool (bridge)

**Files:**
- Create: `bridge/show-image.ts`
- Modify: `bridge/index.ts` (register the tool before the `PI_WEB` return)
- Modify: `bridge/pi-modules.d.ts` (declare `typebox` `Type`, and the
  `registerTool` member on `PiApi` that is used)
- Test: `bridge/test/show-image.test.ts` (unit),
  `bridge/test/extension.test.ts` (real pi)

**Interfaces:**
- Consumes: `sniffImageType` (Task 1).
- Produces:
  - `export const MAX_IMAGE_FILE_BYTES = 2_000_000`
  - `export interface ShowImageParams { path: string; caption?: string; see?: boolean }`
  - `export interface ShowImageDetails { path: string; caption?: string; mimeType: string; bytes: number; image?: { type: "image"; data: string; mimeType: string } }`
  - `export async function showImage(params: ShowImageParams, cwd: string): Promise<{ content: ContentBlock[]; details: ShowImageDetails }>`.
    It throws `Error` with a message for pi to read.
  - Tool name: `show_image`, label `Show image`.

- [ ] **Step 1: Write the failing unit tests** in
  `bridge/test/show-image.test.ts`. Write the fixtures to a temp dir.
  - `a png is returned as an image block the model sees`:
    - `content` is `[{type:"text", text:"Displayed in the conversation: shot.png"}, {type:"image", mimeType:"image/png", data:<base64>}]`;
    - `details` is `{ path: <absolute path>, mimeType: "image/png", bytes: <n> }` with no `image`.
  - `see: false keeps the image out of content`: `content` has only the text
    block, and `details.image` is `{type:"image", data, mimeType:"image/png"}`.
  - `a relative path resolves against cwd`.
  - `the caption is kept in details`.
  - `a file over 2 MB is refused with a downscale hint`: it rejects, and the
    message matches `/2 MB/` and `/downscale/i`.
  - `a non-image is refused`: a `.png` file containing text rejects with
    `/not a PNG, JPEG, GIF or WebP/`.
  - `a missing file is refused`: it rejects, and the message includes the path.
- [ ] **Step 2:** Run `npm run test -w bridge -- test/show-image.test.ts`
  (or `node --test bridge/test/show-image.test.ts`). Expected: FAIL.
- [ ] **Step 3:** Implement `showImage` in `bridge/show-image.ts`. Read the
  file with `node:fs/promises`. Check the size before encoding, then call
  `sniffImageType`.
- [ ] **Step 4: Register the tool** in `bridge/index.ts`, as the first
  statement of `piWebBridge`:
  - the `typebox` parameters: `path` (string), `caption` (optional string),
    `see` (optional boolean, described as "default true; false keeps the
    image out of your context");
  - a description that says what the tool does, the 2 MB cap and the
    accepted types;
  - `execute(_id, params, _signal, _onUpdate, ctx)` calls
    `showImage(params, ctx.cwd)`.
- [ ] **Step 5: Write the failing real-pi tests** in `extension.test.ts`,
  using `model.setScript` to have the fake model call
  `show_image({ path: "shot.png" })` on its first turn and then reply text:
  - `show_image puts the image in the transcript`: the hub receives a
    `tool_execution_end` whose `result.content[1].type === "image"`.
  - `show_image exists in the hub's own headless children (PI_WEB=1)`:
    - under `extraEnv: { PI_WEB: "1" }`, the same script yields a tool result
      that is not an error;
    - drive it through `term.call`/records, since the hub sees nothing;
    - the PI_WEB=1 test that checks nothing connects still passes.
- [ ] **Step 6:** Run `npm run test -w bridge && npm run typecheck -w bridge`.
  Expected: PASS.
- [ ] **Step 7: Commit** with `feat(bridge): show_image tool`.

### Task 3: The hub's image store and outgoing rewrite

**Files:**
- Create: `hub/src/images.ts`
- Test: `hub/test/images.test.ts`

**Interfaces:**
- Consumes: `imageDimensions`, `sniffImageType`, `ImageMime` (Task 1).
- Produces:
  - `export class ImageStore`
  - `constructor(opts?: { maxBytes?: number })`, default 64 MiB
    (67,108,864) of decoded bytes.
  - `outgoing<T>(sessionId: string, value: T): T` returns a deep copy where
    every object shaped `{ type: "image", data: string, mimeType: string }`
    becomes `{ type: "image", mimeType, ref, width?, height? }`. It records
    the bytes in the LRU and the ref in that session's membership set. Other
    values are copied unchanged, and the input is never mutated.
  - `has(sessionId: string, ref: string): boolean`
  - `get(sessionId: string, ref: string): { mimeType: string; bytes: Buffer } | undefined`.
    It is `undefined` when the ref isn't in the session or the bytes were
    evicted.
  - `index(sessionId: string, messages: AgentMessage[]): void` walks the
    messages the same way, recording bytes and membership without copying.
  - `ref` is the lowercase hex sha256 of the decoded bytes.

- [ ] **Step 1: Write the failing tests** in `hub/test/images.test.ts`:
  - `outgoing replaces image data with a ref and leaves the input alone`. The
    input is a snapshot-shaped object with images in:
    - a user message's content;
    - a toolResult's content;
    - `conv.tools[id].result.content`;
    - `details.image`.

    Assert that `JSON.stringify(out)` contains no base64 fixture string, that
    every ref is 64 hex characters, that `width`/`height` are present for the
    png, and that the input is deep-equal to a pre-call clone.
  - `get returns the bytes for a ref in that session only`: the same ref
    under another session id gives `undefined`.
  - `index records refs without copying`.
  - `the LRU evicts by bytes but keeps membership`. With `maxBytes` smaller
    than two images, `get` on the first returns `undefined` while `has` stays
    `true`.
  - `identical images share one ref`.
- [ ] **Step 2:** Run `node --test hub/test/images.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `ImageStore`. Use a `Map` for the LRU, in
  insertion order, as `app/src/lib/markdown.ts` does. Use
  `Map<string, Set<string>>` for membership, and `node:crypto` `createHash`.
- [ ] **Step 4:** Run `npm run test -w hub -- test/images.test.ts`.
  Expected: PASS.
- [ ] **Step 5: Commit** with `feat(hub): image store; images leave the hub as refs`.

### Task 4: Hub wiring (SSE, history, and the image route)

**Files:**
- Modify: `hub/src/server.ts`:
  - `createHubServer` deps: add `images?: ImageStore`, defaulting to
    `new ImageStore()`;
  - `history()` (:166-172);
  - `sessionStream` `sse.send` calls (:174-205);
  - the route table near :104.
- Modify: `hub/src/index.ts` (or wherever `createHubServer` is constructed),
  only if a shared instance is needed.
- Test: `hub/test/server.test.ts`

**Interfaces:**
- Consumes: `ImageStore` (Task 3).
- Produces:
  - route `GET /api/sessions/:id/images/:ref`, where `ref` matches
    `[0-9a-f]{64}`;
  - `200` with `content-type: <mimeType>`, `Cache-Control: private,
    max-age=31536000, immutable`, plus the CORS headers;
  - `404 {"error":"Image not found"}`.

- [ ] **Step 1: Write the failing tests** in `hub/test/server.test.ts`,
  using `FakeHandle` with messages that carry a PNG image block:
  - `the session stream sends snapshots and events without image data`: the
    SSE `snapshot` and a later `tool_execution_end` both contain refs and no
    base64.
  - `history returns refs, live and from disk`.
  - `a ref from the stream is served as bytes`: the body equals the fixture
    PNG, and the headers match.
  - `a ref from another session is 404`.
  - `a ref is served from the session file when no handle is live`. Start
    with a fresh `ImageStore` (as after a restart) and a session `.jsonl` in
    the sessions dir that holds a toolResult with an image; the route
    indexes the file via `readHistory`, then serves the image.
  - `images of a forked session load under its new id`: after a snapshot
    with a new `sessionId`, the route under the new id serves the ref.
  - `the image route refuses requests without an allowed Origin`: the same
    403 as other `/api` routes.
- [ ] **Step 2:** Run `npm run test -w hub -- test/server.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement the wiring:**
  - wrap every `sse.send(msg)` in `sessionStream` as
    `sse.send(images.outgoing(id, msg))`, using the current `id` after the
    fork update;
  - wrap `history()`'s `messages` in `images.outgoing(id, ...)`;
  - the route:
    1. if `!images.has(id, ref)`, call `images.index(id, messages)`, where the
       messages are the live handle's `snapshot().conv.messages`, or
       `readHistory(file)` from `index.find(id)`;
    2. then call `get`;
    3. if `get` misses after a hit on `has` (the bytes were evicted), index
       once more and retry once.
- [ ] **Step 4:** Run `npm test -w hub && npm run typecheck -w hub`.
  Expected: PASS, including the existing watch tests (the watch reads
  handles directly and never sees the rewrite).
- [ ] **Step 5: Commit** with `feat(hub): stream images by reference and serve them per session`.

### Task 5: `<pi-image>` and the image loader (app)

**Files:**
- Create: `app/src/lib/image-loader.ts`
- Create: `app/src/components/pi-image.ts`
- Modify: `app/src/lib/api.ts` (add `image(sessionId, ref)`)
- Test: `app/src/lib/image-loader.test.ts`

**Interfaces:**
- Consumes: the image route (Task 4).
- Produces:
  - `HubApi.image(sessionId: string, ref: string): Promise<Blob>`. It throws
    `HubError` on a non-OK response.
  - `export class ImageLoader { constructor(fetchBlob: (ref: string) => Promise<Blob>, createUrl?: (b: Blob) => string, revokeUrl?: (u: string) => void) }`
  - `load(ref: string): Promise<string>` resolves to a `blob:` URL, shared
    per ref.
  - `dispose(): void` revokes every URL.
  - `<pi-image>` properties (all `attribute: false`):
    - `block: { mimeType; data?; ref?; width?; height? }`
    - `loader: ImageLoader | null`
    - `alt: string`
    - `variant: "figure" | "thumb"`
  - Behaviour:
    - a `data` block renders immediately as a `data:` URL;
    - a `ref` block renders a placeholder. The placeholder takes the
      block's aspect ratio when `width`/`height` are known, and an IntersectionObserver
      (`rootMargin: "400px"`) calls `loader.load`;
    - tap opens a full-screen viewer (a fixed overlay inside the element:
      image `object-fit: contain`, `touch-action: pinch-zoom`), closed by tap
      or Escape.
    - load failure renders the text "image unavailable".

- [ ] **Step 1: Write the failing tests** in `image-loader.test.ts`, with
  fakes for `fetchBlob`, `createUrl` and `revokeUrl`:
  - `two elements with one ref fetch once`: two concurrent `load("r")` calls
    make one fetch and resolve to the same URL.
  - `a failed fetch leaves the unavailable state`: `load` rejects, and a
    later `load` of the same ref tries again (no cached failure).
  - `dispose revokes every url`.
- [ ] **Step 2:** Run `npm run test -w app -- image-loader`. Expected: FAIL.
- [ ] **Step 3:** Implement `ImageLoader` and `HubApi.image`. `image` uses
  plain `fetch` like `downloadExport` (api.ts:90), since it needs the body
  as a Blob.
- [ ] **Step 4:** Implement `<pi-image>`, following `pi-messages.ts`
  conventions (`static properties`, `declare`, `customElements.define`). Its
  `alt` text is the caption when there is one, otherwise `"image"`.
- [ ] **Step 5:** Run `npm run test -w app && npm run typecheck -w app`.
  Expected: PASS.
- [ ] **Step 6: Commit** with `feat(app): lazy pi-image with a full-screen viewer`.

### Task 6: Rendering images in the conversation (app)

**Files:**
- Modify: `app/src/render/messages.ts`:
  - `renderConversation` gains an optional second parameter, `loader: ImageLoader | null = null`, so existing callers and tests are unchanged;
  - `renderUser` (:51-55);
  - `renderTool` (:89-105);
  - a new `renderShowImage`;
  - `messageStyles`.
- Modify: `app/src/components/pi-messages.ts` (add a `loader` property and
  pass it through)
- Modify: `app/src/components/pi-session.ts:378` (create one
  `ImageLoader` per session view from `api.image(sessionId, ref)`, dispose it
  when the session or the view changes, and pass `.loader`)
- Test: `app/src/render/messages.test.ts`; `app/e2e/smoke.spec.ts` (or a new
  `app/e2e/images.spec.ts`)

**Interfaces:**
- Consumes: `<pi-image>`, `ImageLoader` (Task 5); the ref block shape
  (Task 1); the `ShowImageDetails` shape (Task 2).

- [ ] **Step 1: Write the failing render tests.** Render to a string the way
  the existing tests inspect `TemplateResult`s:
  - `a show_image result renders as a figure, not a collapsed card`:
    - the output has a `<pi-image` with `variant` figure;
    - the caption text is shown;
    - the line `show_image · shot.png` is present;
    - there is no `<details class="tool` for that call.
  - `a show_image with see:false takes the image from details.image`.
  - `a running show_image shows the spinner; a failed one the normal error card`.
  - `other tools' images render as thumbnails under the text output`: a
    `read` result with text and an image gives `<pre class="out">` plus a
    thumb `<pi-image>`.
  - `user images render through pi-image`.
  - `inline data images still render`: a block with `data` and no `ref`
    gives a `<pi-image>` whose block keeps its `data`.
- [ ] **Step 2:** Run `npm run test -w app -- messages`. Expected: FAIL.
- [ ] **Step 3:** Implement the rendering:
  - `renderAssistant` routes `toolCall` blocks named `show_image` to
    `renderShowImage` once the result has arrived and is not an error;
  - the figure CSS: `max-width: 100%`, `max-height: 70vh`, caption in
    `--text-secondary`, and the tool line in the `.tool` font size;
  - thumbs reuse the `.imgs` style (160 px).
- [ ] **Step 4: Write the e2e test** `the agent's show_image appears and
  opens full screen`:
  - the e2e hub's pi loads the bridge: `makePiEnv({ extensions: { "bridge.ts": 'export { default } from "<abs>/bridge/index.ts";' } })`;
  - when the prompt contains `show`, the fake model calls `show_image` on a
    PNG in the e2e workdir;
  - assert that the figure becomes visible after scrolling to it, its `img`
    `src` starts with `blob:`, and a tap opens the viewer and a second tap
    closes it.
- [ ] **Step 5:** Run `npm run test -w app && npm run typecheck && npm run e2e -w app`.
  Expected: PASS.
- [ ] **Step 6: Commit** with `feat(app): show_image figures and image thumbnails`.

### Task 7: The show-image skill, the skill pointers, and docs

**Files:**
- Create: `bridge/skills/show-image/SKILL.md`
- Modify: `bridge/package.json`: `"pi": { "extensions": ["./index.ts"], "skills": ["./skills"] }`
- Modify: `README.md` (a short "Images in replies" paragraph: the tool, the
  cap, images by reference)
- Modify, outside the repo:
  - `~/.pi/agent/skills/pebble-phone-dev-connection/SKILL.md` (edited in
    place);
  - `~/workspace/pebble-ui/skills/using-pebble-ui/SKILL.md` (its own commit
    in that repo, **not pushed** until Michael says so).

- [ ] **Step 1: Write `SKILL.md`** with frontmatter `name: show-image` and a
  `description` that starts with "Use when". It covers the trigger
  conditions from the spec: visual output Michael would want to see, or him
  asking to see something. The body:
  - **When:** the spec's points.
  - **How:** save to the cwd or a temp dir, call `show_image`, downscale
    anything over 2 MB (`python3` PIL or `convert -resize`), and use `see:
    false` after you've already looked.
  - **Recipes:**
    - `pebble screenshot --emulator emery --no-open f.png`;
    - the watch, through the `pebble-phone-dev-connection` skill;
    - Playwright's `page.screenshot({ path })`.

  Under 250 words.
- [ ] **Step 2: Verify with pi:**
  - run `pi -p --offline --model spark/qwen3.8-flash-next --no-extensions --no-skills -e bridge/index.ts --skill bridge/skills/show-image "Make a 200x100 PNG of a red square with python and show it to me." < /dev/null`
    in a scratch directory;
  - expected: pi writes the PNG and calls `show_image`, and the output
    includes `Displayed in the conversation:`;
  - if the spark model is busy, record that and leave the step unchecked
    rather than skipping it silently.
- [ ] **Step 3: Add one line** to each outside skill: in pi-web, show a
  screenshot with `show_image`. Commit the pebble-ui change with
  `Skill: point to show_image for screenshots in pi-web`.
- [ ] **Step 4:** Run `npm test && npm run typecheck` at the repo root.
  Expected: PASS.
- [ ] **Step 5: Commit** with `feat(bridge): show-image skill; docs`.

## Deploying (Michael's step, after the final review)

pi loads the bridge from the main checkout (`~/workspace/pi-web/bridge`,
listed in `~/.pi/agent/settings.json` `packages`). Deploying takes three
steps:

1. merge `feat/show-image` into `master` in `~/workspace/pi-web`, which is
   currently on `feature/memory-tab` with uncommitted work;
2. rebuild and publish the app (Cloudflare Pages);
3. `systemctl --user restart pi-web-hub`, and restart any terminal pi
   sessions so they load the new bridge.

Claude does these only with Michael's go-ahead.
