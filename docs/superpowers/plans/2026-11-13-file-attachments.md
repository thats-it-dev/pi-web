# File Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any file can be attached to a pi-web message (＋ menu, drop, paste); the hub saves it under its data dir and tells pi the path, inlining small text files; the transcript shows a chip.

**Architecture:** Files ride as base64 in the existing `prompt` command beside `images`. The hub's commands route saves them to `<dataDir>/uploads/<sessionId>/` and appends an attachments block to the prompt text before handing the command to whichever handle (headless or bridge) serves the session. The block's grammar lives in `shared/`, so the app's renderer turns it back into chips and every one-line view of a user message (titles, watch, queue chips, fork sheet) shows a summary instead.

**Tech Stack:** TypeScript, Lit (app), Node `node:test` (hub, shared), vitest (app), Playwright (e2e). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-13-file-attachments-design.md`

## Global Constraints

- Per-file cap 20 MB raw (`20 * 1024 * 1024`); per-message cap 40 MB raw; hub `MAX_BODY` becomes 64 MB.
- Inline cap 32 KB (`32 * 1024`): UTF-8, no NUL in the first 8 KB, not containing `</pi-web-file>`.
- Uploads root: `join(cfg.dataDir, "uploads")`; per session `join(root, sessionId)`; files 0o600, folders 0o700.
- Toast copy, verbatim: `Files up to 20 MB can be attached.`, `Up to 40 MB of files per message.`, `Files can only go with a message to pi.`
- Files-only prompt text: `Attached:`.
- Grammar (exact; one blank line between the user's text and the block):

```
<pi-web-attachments>
- report.pdf (1.2 MB) → /abs/uploads/s1/report.pdf
- notes.md (3.1 KB) → /abs/uploads/s1/notes.md, contents inlined below
</pi-web-attachments>

<pi-web-file path="/abs/uploads/s1/notes.md">
…file text…
</pi-web-file>
```

- Size format: `B` under 1024, else one decimal `KB` under 1 MiB, else one decimal `MB`.
- Summary line: `text · 2 files` (`1 file` singular); files-only: the first file's name, then ` · N files` when more than one.
- Run checks from the repo root: `npm run typecheck`, `npm test` (or a workspace: `npm test -w hub`, `npm test -w shared`, `npm test -w app`). Code style follows the surrounding file (tabs, one-line comments on the "why").

## Review Focus

1. A file named `../../x` or `con\u0000.txt`: saved under a safe basename inside the session folder, never outside it (Task 2 tests).
2. A second attach of the same name in one session: both files kept, `name (2).ext` (Task 2 tests).
3. A drop while a send is in flight (`busy`): the files are added to the composer, not lost or sent twice (Task 6 routing test covers `addFiles` being pure of `busy`; the composer only reads `busy` in `submit`).
4. Pasting plain text still pastes text; only `clipboardData.files` becomes attachments (Task 6).
5. A user message whose text itself contains `<pi-web-attachments>` typed by hand, with no closing tag: renders as plain text, no crash (Task 1 parser test).

---

### Task 1: Grammar and types in `shared/`

**Files:**
- Modify: `shared/src/protocol.ts:179-186` (add `FileInput`, `files?` on the prompt command)
- Create: `shared/src/attachments.ts`
- Test: `shared/test/attachments.test.ts`

**Interfaces:**
- Produces:
  - `interface FileInput { name: string; mimeType: string; size: number; data: string }` in `protocol.ts`; `AppCommand` prompt variant gains `files?: FileInput[]`.
  - `interface SavedAttachment { name: string; size: number; path: string; inline: string | null }`
  - `formatBytes(n: number): string`
  - `formatAttachments(text: string, files: SavedAttachment[]): string` → the user's text (or `Attached:` when empty after trim), a blank line, the block, then one `<pi-web-file>` element per inlined file, each preceded by a blank line.
  - `parseAttachments(text: string): { text: string; files: Array<{ name: string; sizeLabel: string; path: string; inlined: boolean }> } | null` → `null` when there is no well-formed block (no opening tag, or opening without closing). `text` is everything before the block, trimmed of the trailing blank line. `sizeLabel` is the formatted size as written in the line (`"3.1 KB"`); chips only display it.
  - `summarizeAttachments(text: string): string` → the summary line per Global Constraints; the text unchanged when `parseAttachments` is null.

- [ ] **Step 1: Write the failing tests** in `shared/test/attachments.test.ts` (node:test, like `shared/test/tldr.test.ts`):

```ts
test("formatBytes: B, KB, MB with one decimal", () => {
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(3174), "3.1 KB");
	assert.equal(formatBytes(1258291), "1.2 MB");
});
test("format then parse round-trips names, sizes, paths and the inlined flag; inlined contents are not in the parse", () => { /* two files, one inlined with "hello\n"; expect parse.text === "look at these", files[1].inlined === true, and parse result has no "hello" anywhere */ });
test("a files-only message gets the text 'Attached:'", () => { /* formatAttachments("  ", [pdf]) starts with "Attached:\n\n<pi-web-attachments>" */ });
test("parse: no block → null; opening tag without closing → null; block with no inlined files → files with inlined false", ...);
test("summarize: 'fix this · 2 files', '… · 1 file', files-only 'report.pdf', files-only with three 'report.pdf · 3 files', and a message without a block is returned unchanged", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w shared`
Expected: FAIL, `attachments.ts` not found.

- [ ] **Step 3: Add `FileInput` and `files?` to `shared/src/protocol.ts`; implement `shared/src/attachments.ts`**

Parse by splitting on the first `\n<pi-web-attachments>\n` (or at text start) and the first `\n</pi-web-attachments>` after it; list lines match `^- (.+) \((.+)\) → (.+?)(, contents inlined below)?$`. A file name containing ` (` or ` → ` is still written verbatim; the regex's greedy name group handles it because the size group never contains `)` and the path is absolute. Everything after the closing tag is ignored by the parser.

- [ ] **Step 4: Run the tests**

Run: `npm test -w shared && npm run typecheck -w shared`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/protocol.ts shared/src/attachments.ts shared/test/attachments.test.ts
git commit -m "shared: attachments block grammar and FileInput"
```

---

### Task 2: Hub saves files and rewrites the prompt

**Files:**
- Create: `hub/src/attachments.ts`
- Test: `hub/test/attachments.test.ts`

**Interfaces:**
- Consumes: `FileInput`, `SavedAttachment`, `formatAttachments` from Task 1.
- Produces:
  - `safeName(name: string): string` → basename only (after the last `/` or `\`), control characters removed, trimmed, `file` when empty.
  - `isInlineText(bytes: Buffer): boolean` → the inline rule in Global Constraints.
  - `saveAttachments(dir: string, files: FileInput[]): Promise<SavedAttachment[]>` → creates `dir` (0o700, recursive), writes each file (0o600) with collision suffix ` (2)`, ` (3)` before the extension, throws `HttpError(413, "<name> is over 20 MB")` when the decoded bytes exceed the cap (before writing anything for that message).
  - `withAttachments(cmd: PromptCommand, dir: string): Promise<PromptCommand>` where `PromptCommand = Extract<AppCommand, { type: "prompt" }>` → the same command with `files` removed and `text` replaced by `formatAttachments(text, saved)`; a command with no files is returned as is.

- [ ] **Step 1: Write the failing tests** (node:test, a `mkdtemp` dir per test):

```ts
test("safeName drops directories and control characters, and never returns empty", () => { "../../x" → "x"; "a/b\\c.txt" → "c.txt"; "con\u0000.txt" → "con.txt"; "  " → "file" });
test("isInlineText: small UTF-8 yes; a NUL byte no; over 32 KB no; invalid UTF-8 no; containing </pi-web-file> no", ...);
test("saveAttachments writes files 0o600 under dir, keeps both on a name collision as 'report (2).pdf', and returns inline text only for text files", ...);
test("saveAttachments refuses a file over 20 MB with 413 and writes nothing", ...);
test("withAttachments rewrites the text, strips files, and leaves a prompt without files untouched", () => { /* result.text contains "→ <dir>/notes.md, contents inlined below" and "<pi-web-file path=" ; result.files === undefined */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w hub -- --test-name-pattern=attachments` (or `node --test hub/test/attachments.test.ts`)
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `hub/src/attachments.ts`**

Use `fs/promises` (`mkdir`, `writeFile` with `{ mode: 0o600, flag: "wx" }` to detect collisions, retry with the next suffix). Decode with `Buffer.from(data, "base64")`; check the cap on the decoded length for every file before writing the first.

- [ ] **Step 4: Run the tests**

Run: `node --test hub/test/attachments.test.ts && npm run typecheck -w hub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/attachments.ts hub/test/attachments.test.ts
git commit -m "hub: save prompt attachments and rewrite the prompt text"
```

---

### Task 3: Commands route, body limit, validation

**Files:**
- Modify: `hub/src/server.ts:40-60` (`HubDeps`, `createHubServer`), `:168-172` (commands route), `:359-366` (`parseCommand`)
- Modify: `hub/src/http.ts:7` (`MAX_BODY = 64 * 1024 * 1024`)
- Test: `hub/test/server.test.ts` (extend the `commands:` test block)

**Interfaces:**
- Consumes: `withAttachments` from Task 2.
- Produces: `HubDeps.uploadsDir?: string`, default `join(cfg.dataDir, "uploads")`. The route calls `withAttachments(cmd, join(uploadsDir, h.sessionId))` for a prompt with files, after `registry.ensure(id)` and before `h.command(...)`, for every handle kind.

- [ ] **Step 1: Write the failing tests** in `hub/test/server.test.ts`, next to the existing commands test:

```ts
test("commands: a prompt with files is saved under uploads/<session> and the handle gets the rewritten text, for rpc and bridge handles", async () => {
	// POST { type: "prompt", text: "look", files: [{ name: "a.txt", mimeType: "text/plain", size: 5, data: base64("hello") }], mode: "send" }
	// expect: file exists at join(cfg.dataDir, "uploads", "disk-1", "a.txt") with "hello"
	// expect: handles.get("disk-1").received.at(-1).text includes "<pi-web-attachments>" and "contents inlined below"; .files === undefined
	// repeat with a FakeHandle of kind "bridge" attached via registry.attachBridge
});
test("commands: malformed files are a 400; a file over 20 MB is a 413", async () => { /* files: "nope" → 400; files: [{ name: 1 }] → 400; a 21 MB base64 payload → 413 (keep this one fast: build the string once with "A".repeat) */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test hub/test/server.test.ts`
Expected: FAIL (handle received the raw text with `files`; 400 for `files: "nope"` is missing).

- [ ] **Step 3: Implement**

`parseCommand`: when `cmd.type === "prompt"` and `cmd.files !== undefined`, require an array whose every item has string `name`, `mimeType`, `data` and number `size`, else `HttpError(400, "Bad files")`. Raise `MAX_BODY`. Add `uploadsDir` to `HubDeps` and the route call.

- [ ] **Step 4: Run the tests**

Run: `npm test -w hub && npm run typecheck -w hub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/server.ts hub/src/http.ts hub/test/server.test.ts
git commit -m "hub: prompts carry files; saved before the handle sees the command"
```

---

### Task 4: Reads inside the uploads root are benign in `semi`

**Files:**
- Modify: `hub/src/auto-approve.ts:37-43` (`ApprovalContext`), `:65-75` (`benignTool`)
- Modify: `hub/src/rpc-handle.ts:53-63` (`RpcHandleOptions.uploadsDir?: string`), `:483` (pass it in the context)
- Modify: `hub/src/main.ts:44` (pass `uploadsDir: join(cfg.dataDir, "uploads")` to `RpcHandle.start`)
- Test: `hub/test/auto-approve.test.ts` (extend the `semi:` test)

**Interfaces:**
- Produces: `benignTool(tool: PendingTool, cwd: string, uploadsDir?: string): boolean`; `ApprovalContext.uploadsDir?: string`. Only `READS` are benign under `uploadsDir`; `WRITES` there still ask.

- [ ] **Step 1: Write the failing assertions**

```ts
assert.equal(benignTool({ name: "read", args: { path: "/data/uploads/s1/report.pdf" } }, CWD, "/data/uploads/s1"), true, "read inside uploads");
assert.equal(benignTool({ name: "write", args: { path: "/data/uploads/s1/x" } }, CWD, "/data/uploads/s1"), false, "write inside uploads asks");
assert.equal(benignTool({ name: "read", args: { path: "/data/uploads/s2/report.pdf" } }, CWD, "/data/uploads/s1"), false, "another session's uploads");
// and through autoAnswer: ctx { mode: "semi", running: true, cwd: CWD, uploadsDir: "/data/uploads/s1", tool: read of /data/uploads/s1/a.pdf } → { confirmed: true } / the allow option, matching the existing semi test's shape
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test hub/test/auto-approve.test.ts`
Expected: FAIL on "read inside uploads".

- [ ] **Step 3: Implement**, reusing `insideFolder(path, uploadsDir)`.

The handle's `uploadsDir` is the session's folder: `join(opts.uploadsDir, this.sessionId)`; the session id can change on `new_session`/`fork`, so compute it in the `autoAnswer` call, not in the constructor.

- [ ] **Step 4: Run the tests**

Run: `npm test -w hub && npm run typecheck -w hub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/auto-approve.ts hub/src/rpc-handle.ts hub/src/main.ts hub/test/auto-approve.test.ts
git commit -m "hub: reading an attached file is benign in semi mode"
```

---

### Task 5: One-line views of a user message show the summary

**Files:**
- Modify: `hub/src/sessions.ts:42` (`firstPrompt`), `hub/src/push-watch.ts:95-101` (`sessionTitle`), `hub/src/watch-sessions.ts:73` (`turnsFrom`, user turns)
- Modify: `app/src/lib/format.ts:40-42` (`sessionTitle`), `app/src/components/pi-composer.ts:349` (queue chips), `app/src/render/sheets.ts:126-129` (`forkSheet`)
- Test: `hub/test/push-watch.test.ts:124`, `hub/test/watch.test.ts:657`, a new `sessions` case in `hub/test/queries.test.ts` or wherever `firstPrompt` is already tested (grep `firstPrompt` in `hub/test`), `app/src/lib/format.test.ts`

**Interfaces:**
- Consumes: `summarizeAttachments(text)` from Task 1. Each site wraps the text it already derives: `summarizeAttachments(contentText(...))`, `summarizeAttachments(t)` for queue strings and `p.text` for fork points.

- [ ] **Step 1: Write the failing tests** (one per site, using a text built with `formatAttachments("fix the parser", [pdf])` from `shared/`):

```ts
// push-watch: sessionTitle(snap with that first user message) === "fix the parser · 1 file"
// watch: turnsFrom([...]) user turn text === "fix the parser · 1 file" (no "<pi-web" anywhere)
// sessions: firstPrompt of a session file whose first user message carries the block === "fix the parser · 1 file"
// app format: sessionTitle({ name: null, firstPrompt: formatted }) === "fix the parser · 1 file"
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w hub` and `npm test -w app`
Expected: FAIL on the four new assertions.

- [ ] **Step 3: Implement**: wrap each site; the queue chips and `forkSheet` get the same wrapper without a test (they are templates).

- [ ] **Step 4: Run the tests**

Run: `npm test -w hub && npm test -w app && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/sessions.ts hub/src/push-watch.ts hub/src/watch-sessions.ts app/src/lib/format.ts app/src/components/pi-composer.ts app/src/render/sheets.ts hub/test app/src/lib/format.test.ts
git commit -m "titles, watch, queue and fork views summarise attachments"
```

---

### Task 6: Composer attachments (chips, caps, routing, paste, two pickers)

**Files:**
- Create: `app/src/lib/files.ts`
- Test: `app/src/lib/files.test.ts`
- Modify: `app/src/components/pi-composer.ts` (state `attachments`, `canImages`, `addFiles`, `pick`, paste, chips, submit split, `restore`), `app/src/lib/draft.ts` (`files` on `Draft` and `Handoff`), `app/src/lib/draft.test.ts`
- Modify: `app/src/render/chat-menu.ts:24-55` (row `file`), `app/src/render/chat-menu.test.ts`

**Interfaces:**
- Consumes: `checkImageFile` from `app/src/lib/images.ts`; `FileInput` from Task 1; `formatBytes` from Task 1.
- Produces, in `app/src/lib/files.ts`:
  - `MAX_FILE_BYTES = 20 * 1024 * 1024`, `MAX_MESSAGE_BYTES = 40 * 1024 * 1024`
  - `type Attachment = { kind: "image"; name: string; size: number; image: ImageInput } | { kind: "file"; file: FileInput }`
  - `acceptFiles(files: Array<{ name: string; type: string; size: number }>, already: number): { ok: typeof files; error: string | null }` → drops over-cap files (`already` is the raw byte total of the attachments the composer holds); `error` is the first applicable toast copy from Global Constraints, else null.
  - `routeAttachments(list: Attachment[], canImages: boolean): { images: ImageInput[]; files: FileInput[] }` → an image attachment goes to `images` when `canImages`, else becomes a `FileInput` built from its `name`, `size`, `image.mimeType` and `image.data`.
  - `readAsBase64(f: File): Promise<string>` (the existing FileReader code from `onFiles`, moved).
- Composer public API:
  - property `canImages: boolean` (default false)
  - `addFiles(files: File[]): Promise<void>` → `acceptFiles`, read, append to `attachments`; an image type passing `checkImageFile` becomes an image attachment, anything else a file attachment.
  - `pick(kind: "image" | "file"): void` replaces `pickImages()`; two hidden inputs, `input[data-kind=image]` with `accept="image/*"` and `input[data-kind=file]` without.
  - `restore(text: string, images: ImageInput[], files: FileInput[]): void`
  - `SubmitDetail { text; images; files: FileInput[]; mode }`
- Draft: `Draft.files: FileInput[]`, `Handoff.files: FileInput[]`, `fresh()` includes `files: []`.
- `menuRows` emits `{ key: "file", label: "attach file", value: "", disabled: false }` right after the image row, always; `MenuRowKey` gains `"file"`; `ChatMenuHandlers.attach(kind: "image" | "file")`; `ICONS.file` is Lucide `paperclip`.

- [ ] **Step 1: Write the failing tests**

`app/src/lib/files.test.ts`:
```ts
it("acceptFiles drops a file over 20 MB with the per-file toast", ...); // error === "Files up to 20 MB can be attached."
it("acceptFiles drops files that would push the message over 40 MB with the per-message toast", ...);
it("routeAttachments sends images to images with vision and to files without", ...);
```
`app/src/lib/draft.test.ts`: update the two `toEqual` fixtures to include `files: []`, and `resetDraft clears files`.
`app/src/render/chat-menu.test.ts`:
```ts
it("always lists attach file, after attach image when that is shown", () => { labels with canImages true: ["attach image", "attach file", "folder", ...]; with false: starts ["attach file", "folder"] });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w app`
Expected: FAIL (`files.ts` missing; menu has no "attach file").

- [ ] **Step 3: Implement `files.ts`, draft changes, the menu row, and the composer**

Composer rendering: the `.thumbs` row becomes `.attachments`, rendering image attachments as today's 48 px thumbs and file attachments as `<button class="chip file" aria-label="Remove <name>">` with the paperclip icon, the name (`.name` with `text-overflow: ellipsis`, `max-width: 14rem`) and `formatBytes(size)`. `submit()` uses `routeAttachments(this.attachments, this.canImages)` and sends when text, images or files are non-empty. `paste` listener on the textarea: if `e.clipboardData?.files.length`, `preventDefault()` and `addFiles([...files])`. The `onFiles` change handler for both inputs calls `addFiles` (the image input additionally keeps today's image-only toast when a non-image gets through).

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w app && npm run typecheck -w app`
Expected: PASS; typecheck will fail in `pi-session.ts`/`pi-new-chat.ts` until Task 7 updates their calls. Fix the call sites minimally in this task (pass `[]` / `d.files`) so typecheck passes, since Task 7 wires the behaviour.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/files.ts app/src/lib/files.test.ts app/src/lib/draft.ts app/src/lib/draft.test.ts app/src/components/pi-composer.ts app/src/render/chat-menu.ts app/src/render/chat-menu.test.ts app/src/components/pi-session.ts app/src/components/pi-new-chat.ts
git commit -m "app: file attachments in the composer, menu row, paste"
```

---

### Task 7: Session and new-chat wiring, bash/builtin refusal

**Files:**
- Modify: `app/src/components/pi-session.ts:72` (`pendingPrompt` gains `files`), `:232-235` (restore), `:292-301` (handoff and submit carry `files`), `:305-318` (`send(text, images, files, mode)`: refuse files with bash/builtin via `toast("Files can only go with a message to pi.", "warning")` and `restore`), `:545` (`.canImages=${Boolean(model?.input.includes("image"))}` on `<pi-composer>`), `:585-601` (`attach: (kind) => this.composer?.pick(kind)`)
- Modify: `app/src/components/pi-new-chat.ts:85-92` (draft keeps `files`), `:138-141` and `:172-187` (`start(text, images, files)`, `handOff` with `files`), `:277-280` (`attach(kind)`), composer `.canImages` from `this.choice.model?.input.includes("image")`

**Interfaces:**
- Consumes: Task 6's composer API, `Draft.files`, `Handoff.files`.

- [ ] **Step 1: Wire every site listed above.** No new unit tests: these components have none today; the e2e test in Task 9 covers the path end to end.

- [ ] **Step 2: Typecheck and run the app tests**

Run: `npm run typecheck -w app && npm test -w app`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/pi-session.ts app/src/components/pi-new-chat.ts
git commit -m "app: files travel with the prompt, handoff, draft and restore"
```

---

### Task 8: Drop target overlay, and chips in the transcript

**Files:**
- Create: `app/src/lib/drop.ts`
- Test: `app/src/lib/drop.test.ts`
- Modify: `app/src/components/pi-session.ts` and `app/src/components/pi-new-chat.ts` (host listeners, overlay)
- Modify: `app/src/render/messages.ts:62-66` (`renderUser`), styles in the same file
- Test: `app/src/render/messages.test.ts` (extend `images in the conversation` or add `attachments in the conversation`)

**Interfaces:**
- Produces, `app/src/lib/drop.ts`: `class DropTarget { over = false; enter(e: DragEvent): void; leave(): void; drop(e: DragEvent): File[]; }` with a depth counter: `over` is true from the first `dragenter` that carries files (`e.dataTransfer?.types.includes("Files")`) until as many `dragleave`s, or a `drop`, which resets the depth and returns `[...e.dataTransfer.files]`. `dragover` handling (`preventDefault`) stays in the component.
- `renderUser` uses `parseAttachments` from Task 1: when non-null, renders the text part through `blocksText`-equivalent markdown, then `<div class="files">` with one `<span class="chip file">` per file (paperclip, name, `sizeLabel`); the same chip look as the composer (copy the CSS; the two shadow roots don't share styles).

- [ ] **Step 1: Write the failing tests**

`drop.test.ts`:
```ts
it("over turns on at the first file dragenter and off after the matching dragleaves", ...);
it("a drag without files never turns over on", ...);
it("drop resets and returns the files", ...);
```
`messages.test.ts`:
```ts
it("a user message with an attachments block renders chips, hides the inlined contents and keeps the text", () => { /* content formatted by formatAttachments("look", [{ name: "notes.md", ..., inline: "SECRET" }]); rendered HTML includes "notes.md", "look", not "SECRET", not "<pi-web" */ });
it("a user message with an unterminated block renders as plain text", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w app`
Expected: FAIL.

- [ ] **Step 3: Implement** `drop.ts`, `renderUser`, and in both components: `@dragenter`, `@dragover` (`preventDefault`), `@dragleave`, `@drop` on the host (`this.addEventListener` in `connectedCallback`, removed in `disconnectedCallback`); a state `dragOver` drives a full-host overlay `<div class="drop">drop to attach</div>` (position absolute inset 0, dashed 2 px `var(--primary)` border, background `color-mix(in srgb, var(--primary), transparent 88%)`, pointer-events none, centred text). `drop` calls `this.composer?.addFiles(files)`.

- [ ] **Step 4: Run the tests**

Run: `npm test -w app && npm run typecheck -w app`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/drop.ts app/src/lib/drop.test.ts app/src/components/pi-session.ts app/src/components/pi-new-chat.ts app/src/render/messages.ts app/src/render/messages.test.ts
git commit -m "app: drop to attach, attachment chips in the transcript"
```

---

### Task 9: End-to-end smoke test

**Files:**
- Modify: `app/e2e/smoke.spec.ts`

- [ ] **Step 1: Add the test**, modelled on `new chat: send creates the session in ~ and the reply streams`:

```ts
test("attach a text file: the chip shows in the sent message and pi gets the path", async ({ page }) => {
	// open a new chat; page.locator("pi-composer input[data-kind=file]").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello from a file") })
	// expect the composer chip "notes.txt"; type "read it" and send
	// expect a user message containing a chip "notes.txt" and not containing "hello from a file"
	// expect the file at join(hub data dir for e2e, "uploads", <session id from location.hash>, "notes.txt")
});
```
`app/e2e/hub-for-e2e.ts` exposes the hub's data dir; read it from there (add an export if it has none).

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -w app -- -g "attach a text file"` (check `app/package.json` for the exact e2e script name)
Expected: PASS on desktop and mobile projects.

- [ ] **Step 3: Full check and commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

```bash
git add app/e2e/smoke.spec.ts app/e2e/hub-for-e2e.ts
git commit -m "e2e: attach a file to a new chat"
```
