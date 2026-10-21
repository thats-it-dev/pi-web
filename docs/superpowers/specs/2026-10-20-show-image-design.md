# Images in pi's replies

2026-10-20 · branch `feat/show-image`

## Intent

Michael wants pi to show him screenshots inside its reply in pi-web: a Pebble
app on the emulator or the Time 2, a web page it changed, a chart it drew,
"anything else we're working on". Today pi can look at an image itself (the
`read` tool returns a PNG as an image block), but pi-web drops image blocks
from tool output, and the markdown renderer turns `![](...)` into a link on
purpose. So pi can see its work and Michael can't.

Michael skipped the design questions, so the choices below that aren't
quoted from him are Claude's calls, marked **(call)**.

## Goals

1. pi can put an image from a local file into its reply, and pi-web shows it
   inline, large enough to judge, on the phone and on a laptop.
2. Images that any tool returns (such as `read` on a PNG) are visible in that
   tool's card too, instead of being silently dropped.
3. The image survives a reload: reopening the session shows it again.
4. pi knows when and how to use it, through a short skill.
5. A session with many images (Michael: "Many; keep it fast") opens as fast
   as one without. No image bytes travel in snapshots, history or live
   events. Each image loads on its own, when it scrolls into view.

## Non-goals

- Fetching images from URLs. Markdown images stay links (the markdown module's
  "nothing loads from third-party hosts" rule holds).
- Image editing, galleries, or comparing images side by side.
- Showing images on the watch.
- New screenshot tools. pi already has `pebble screenshot`, Playwright and
  plotting libraries; this feature only displays a file they produce.

## Anti-goals

- A route that lets the hub serve arbitrary files from disk by path.
- A large image making the session slow to open, or the model's context fill
  up without anyone choosing that.

## Design

### The tool: `show_image` (bridge extension)

Registered by `bridge/index.ts` with `pi.registerTool`, **before** the
`PI_WEB=1` early return. The hub spawns its own pi sessions with `PI_WEB=1`
and the extension returns at once there, so a tool registered after that line
would be missing from exactly the sessions pi-web runs.

Parameters (TypeBox):

- `path` (string, required): an image file. Relative paths resolve against the
  session's cwd.
- `caption` (string, optional): one line shown under the image.
- `see` (boolean, optional, default `true`) **(call)**: whether the model also
  receives the image. `true` lets pi check its own work, which suits
  screenshots of something it just built. `false` keeps the image out of the
  model's context (UI only) for when pi has already looked or the image is
  just for Michael.

The tool is registered in every pi session, terminal ones included **(call)**.
The bridge mirrors terminal sessions into pi-web, so the image can be seen
there later. Its description and result text say "displayed in the
conversation", never "shown to Michael", because nobody may be watching.

Behaviour:

- The type comes from the file's magic bytes, not its extension. PNG, JPEG,
  GIF and WebP are accepted (the same set as `app/src/lib/images.ts`).
  Anything else is an error.
- Size cap: 2 MB of file **(call)**. Over the cap, the tool fails with a
  message telling pi to downscale first (for example with
  `python3 -c "from PIL import Image..."` or `convert -resize`). The cap
  limits how much each image adds to the session file and to the model's
  context. No image library is added to the bridge.
- Result, stored once:
  - `see: true`: `content` = `[text, image]`, where the text is a short line
    (`Displayed in the conversation: <path>`). `details` = `{ path, caption, mimeType,
    bytes }` with no image data.
  - `see: false`: `content` = `[text]` only, and the image data goes in
    `details.image = { data, mimeType }`.
- Errors throw, so pi marks the result as an error, as `docs/extensions.md`
  describes.

### Rendering (app)

- `show_image` results render as a **figure in the reply**, not inside a
  collapsed tool card: the image at full column width (`max-width: 100%`,
  `max-height` about 70vh, aspect kept), the caption below it in the
  secondary text colour, and a small `show_image · <path>` line in the tool
  styling so it's still clear where it came from. The image comes from the
  result's image block if there is one, otherwise from `details.image`.
  With `see: true`, pi stores its own re-encoded copy of the image (at most
  2000×2000 px, possibly JPEG at quality 80; `docs/models.md`). pi-web shows
  that copy, which is fine for viewing **(call)**. The mimeType comes from the
  block itself, not from `details`.
- Tapping the image opens an in-app full-screen viewer: the image fitted to
  the screen, pinch-zoom where the browser allows, closed by tap or Escape
  **(call)**. There is no new tab, because the app runs as a standalone PWA
  from the iPhone home screen, where `blob:` tabs are unreliable.
- While the tool is running, the figure shows the existing spinner. If the
  tool fails, it falls back to the normal error tool card.
- **Any other** tool result with image blocks (`read` on a PNG, for one) shows
  those images as thumbnails inside its tool card, under the text output,
  styled like the user-message thumbnails. Text output is unchanged.
- Images bind through Lit attributes (`src=data:...`), never through
  `unsafeHTML`.

### Data path: images travel by reference

pi keeps full image data in its session, and the model's context is
unchanged. The hub stops sending image bytes to the app.

**What still carries image bytes.** The bridge-to-hub socket and pi's RPC
stdout. Both are local.

**Hub rewrite on the way out.** Everything the hub sends the app has its image
data replaced by a reference. That covers SSE snapshots and live events
(`tool_execution_*`, `message_*`), the `history()` response, and any other
route that returns messages.

- **What gets replaced:**
  - every image block in message `content`: user attachments, tool results,
    `read` on a PNG;
  - `details.image` on `show_image` results.
- **The reference:** `{ type: "image", mimeType, ref }`, where `ref` is the
  sha256 of the decoded bytes. Add `width` and `height` when the header can
  be parsed cheaply (PNG, JPEG, GIF, WebP), so the app can reserve space
  before the image loads. `shared/src/protocol.ts` gets this variant.
- **What gets copied:** the rewrite works on copies. Messages the hub holds,
  or sends back to pi (forks, resyncs), keep their data.

**Image route.** `GET /api/sessions/:id/images/:ref` returns the bytes with
their mimeType and `Cache-Control: private, max-age=31536000, immutable`.

- **Gate:** the same as every other `/api` route (`checkRequest`: tailnet
  identity and allowed Origin). Nothing reads a path from the request.
- **Scope:** a `ref` that doesn't occur in that session's messages gets 404.
- **Where the bytes come from:** the live handle's messages, or the session
  file through `readHistory` for a session that isn't live. So images still
  load after a hub restart. How the hub indexes refs to bytes is left to the
  builder, with two requirements:
  - memory is bounded: no keeping every image of every session in RAM;
  - a long session doesn't re-read its whole file for each image.

**App loading.** Image references render as a placeholder that reserves the
image's aspect ratio when `width`/`height` are known. When the placeholder
scrolls near the viewport (IntersectionObserver), the app fetches the image
through its existing hub client (`fetch`, so `connect-src` already allows it)
and shows it from a `blob:` URL (`img-src blob:` is already allowed). There is
no CSP change, and plain `<img src>` would fail the hub's Origin check anyway.

- Blob URLs are cached by `ref` for the page's lifetime, so the same
  screenshot shown twice is fetched once.
- They are revoked when the conversation view is torn down.
- A failed fetch shows a small "image unavailable" note in place of the image.
- This applies to every image the app shows: `show_image` figures, tool-card
  thumbnails, and user-attached thumbnails (old sessions with photos get
  faster too).

**Tests** cover each layer:

- the hub's rewrite: snapshot, live event and history, none with base64 left;
- the image route: hit, 404 for a ref from another session, served after a
  restart from the file;
- the app's lazy loader.

### Watch

The watch takes only text and already skips tool results. A `show_image` call
appears in history as `show_image · <path>`, through the existing tool line.
Nothing else is needed. Rendering images on the watch is a non-goal.

### The skill

A `show-image` skill ships in the bridge package (`"pi": { "skills": [...] }`
in `bridge/package.json`), so it travels with the tool. It is short:

- **When:** after producing anything visual Michael would want to see (a
  screenshot of a UI change, a watch screen, a chart), or when he asks to see
  something.
- **How:** save a file in the session's cwd or a temp dir, then call
  `show_image`. Downscale anything over 2 MB first. Use `see: false` when
  you've already looked at the image.
- **Recipes (one line each):**
  - Pebble emulator: `pebble screenshot --emulator emery --no-open f.png`.
  - Watch: follow the `pebble-phone-dev-connection` skill's screenshot
    command.
  - Web page: Playwright's `page.screenshot`.
- The `pebble-phone-dev-connection` and `using-pebble-ui` skills each get one
  line pointing to `show_image` for showing screenshots in pi-web. These live
  outside this repo **(call)**:
  - `~/.pi/agent/skills/pebble-phone-dev-connection` is unversioned and is
    edited in place.
  - `using-pebble-ui` gets its own commit in `~/workspace/pebble-ui`, pushed
    with Michael's OK.

## Constraints

- pi 1.0.2 extension API: `registerTool`, a result with `content` (text and
  image) and `details`. The bridge has no runtime dependencies and keeps it
  that way.
- The hub service runs from the main checkout (`~/workspace/pi-web`), and pi
  loads the bridge from there (`~/.pi/agent/settings.json` packages). The work
  happens in the worktree. Merging to `master` and restarting the hub is
  Michael's step, or Claude's with his approval.
- The model's context must not change: pi's own messages keep their image
  data, and only the hub-to-app copy is rewritten.
- Tests: the existing runners per package (vitest for app, `node --test` for
  bridge, hub and shared). The bridge's extension tests run real pi.

## Left to the builder

- Component structure in the app (a new `renderImageTool`, or a branch in
  `renderTool`) and the exact CSS.
- The hub's ref index (structure, eviction) and how header dimensions are
  parsed, within the requirements above.
- How to detect image type from magic bytes.
- The exact wording of the tool description and the skill, within the
  points above.
- Whether to add a Playwright e2e check, beyond unit tests.
