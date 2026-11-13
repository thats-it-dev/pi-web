# File attachments in pi-web

Date: 2026-11-13. Status: draft, for Michael's approval.

## Why

pi-web can attach images to a message (the ＋ menu's "attach image" row), and nothing else. Michael: "lets add
support for uploading files for pi~. right now we only support images". A log, a CSV, a PDF, a design file or a
zip has to reach pi some other way today (scp, pasting the contents into the message, or pointing pi at a path).

Michael's answers in chat (2026-11-13), everything else below is Claude's call, marked **(call)**:

- pi gets the file **both ways**: it is always saved to disk and the message tells pi the path; small text files
  are also inlined into the prompt so pi doesn't need a tool call.
- The picker accepts **anything**.
- Three entry points: the **＋ menu** (a row beside "attach image"), **drag and drop** onto the chat, and
  **paste** from the clipboard.
- Files land in the **hub's data dir, outside the repo**, not in the session folder.
- Caps: **20 MB per file**, text files up to **32 KB** are also inlined.

## Goals

1. Any file can be attached to a message from the ＋ menu, by dropping it on the chat, or by pasting it, in a
   running session and in a new chat (where it rides along with the first message).
2. pi always gets an absolute path it can read with its own tools, plus the contents of small text files inline.
3. The transcript shows what was attached as a compact chip, in the composer before sending and in the sent user
   message after, and the chip survives a reload.
4. Nothing lands in the project's working tree: a dropped file never shows in `git status`.
5. A failed send puts the files back in the composer, exactly like images today.

## Non-goals

- No PDF, docx or spreadsheet text extraction in pi-web. These are saved only; pi uses its tools (`pdftotext`,
  python) when it needs the contents.
- No browse-the-uploads UI, no re-attaching an earlier upload from a list, no download link in the transcript.
- No upload progress bar: 20 MB over the tailnet is a few seconds, and the send button's existing busy state covers
  it.
- No changes to pi itself. pi's RPC prompt takes text and images; files are carried by text.
- Pasted or dropped *text* (plain strings) keeps going into the textarea as typed text, not as a file.

## Anti-goals (a failure even if it technically works)

- A file that pi can't find: a relative path, a `~` path pi's tools don't expand, a name that got mangled.
- A 20 MB file inlined into the prompt, or a text file inlined twice (in the message and again when pi reads it)
  because the message didn't say it was already inlined.
- The transcript showing a wall of inlined file contents inside the user's bubble.
- A dropped file replacing the page (the browser's default drop behaviour).

## Design

### Where files go

**(call)** `<dataDir>/uploads/<sessionId>/<name>`, where `dataDir` is the hub's (`~/.config/pi-web` by default,
`PI_WEB_DATA_DIR` otherwise; see `hub/src/config.ts`). One folder per session, so the uploads of a chat are easy
to find and to delete together. The file keeps its original basename, sanitised (path separators and control
characters dropped, empty name becomes `file`); a name that already exists in the folder gets ` (2)`, ` (3)`
before the extension. Files are never pruned by pi-web (an upload is small next to the session's history and
Michael can clear the folder).

The session id is known at prompt time in every path: a running session has it, and the new-chat page creates the
session before it hands the first message over (`pi-new-chat.ts` `start()` → `handOff`).

### Transport: files ride in the prompt command, like images

**(call)** The app reads each file as base64 and sends it in the existing `prompt` command, beside `images`:

```ts
export interface FileInput {
	name: string; // the original basename, as picked
	mimeType: string; // what the browser said, may be ""
	size: number; // bytes, so the chip can show it without decoding
	data: string; // base64, no data: prefix
}
// AppCommand
| { type: "prompt"; text: string; images?: ImageInput[]; files?: FileInput[]; mode: PromptMode }
```

Why not a separate upload route: the prompt command is already the thing that knows the session id, carries
base64 payloads, is retried on failure, and is held in the draft and the new-chat handoff. A separate route would
need an upload-before-session step for new chats and a second failure path. The hub's request body limit is
50 MB (`hub/src/http.ts` `MAX_BODY`), so **(call)** the app caps a message at 20 MB per file and 40 MB of files in
total, counted on the raw sizes; base64 of 40 MB is 53 MB, so the limit rises to 64 MB in the same change.

The hub's `parseCommand` (`hub/src/server.ts`) validates `files`: an array of objects with string `name`,
`mimeType`, `data` and a number `size`; anything else is a 400.

### What the hub does with them

**(call)** In the hub's commands route (`server.ts`, between `registry.ensure(id)` and `h.command(cmd)`), not
inside `RpcHandle`: a session can also be served by a terminal pi over the bridge (`BridgeHandle` forwards the
prompt verbatim and the bridge extension only reads `text` and `images`), and a file attached there would vanish
silently otherwise. The terminal pi runs on the same machine as the hub (the bridge socket lives in the data dir),
so one save-and-rewrite step before `h.command()` serves both handle kinds. Steps:

1. Write each file to the uploads folder (mode 0o600, folder 0o700 like the data dir). Decoding is the source of
   truth for the size; a file whose decoded bytes exceed 20 MB is a `command_error`, not a silent truncation.
2. Decide whether a file is **text**: its decoded bytes are at most 32 KB, contain no NUL byte in the first 8 KB,
   and decode as UTF-8 without replacement characters. The browser's `mimeType` is a hint only (it is often empty
   or wrong for `.ts`, `.md`, `.log`).
3. Append an attachments block to the prompt text, in a fixed shape the app can recognise again (next section):

```
<the user's text>

<pi-web-attachments>
- report.pdf (1.2 MB) → /home/michael/.config/pi-web/uploads/abc123/report.pdf
- notes.md (3.1 KB) → /home/michael/.config/pi-web/uploads/abc123/notes.md, contents inlined below
</pi-web-attachments>

<pi-web-file path="/home/michael/.config/pi-web/uploads/abc123/notes.md">
…the file's text…
</pi-web-file>
```

The list line tells pi the path and size of every file and, for inlined ones, says so, so pi doesn't read it
again. Inlined files follow the list, each in a `<pi-web-file path="…">` element; a file whose contents contain
the literal closing tag is saved but not inlined (**(call)**, simplest safe rule). A prompt with files and no text
gets the text `Attached:` so pi has something to act on. **(call)** The message text pi receives, and therefore the
one in the session history, is this rewritten text; nothing is stored separately, so the chips survive a reload
because the renderer rebuilds them from the text.

The translated RPC prompt (`translate.ts`) is unchanged apart from the text. `images` keep going as today.

### How it looks

**Composer.** A `.files` row beside the image thumbnails: one chip per file with a paperclip icon, the name
(ellipsised in the middle on narrow screens, so the extension stays visible), the size (`3.1 KB`, `1.2 MB`) and a
remove ×. The chip uses the kit's existing chip styling (`pi-composer.ts` `.chip`), solid border instead of the
queue's dashed one. The send button enables when there are files, text or images.

**Transcript.** `renderUser` in `app/src/render/messages.ts` splits the text at `<pi-web-attachments>`: the part
before renders as today; the block becomes the same chips (name and size, no remove, no link); the
`<pi-web-file>` elements are not shown at all. A message that doesn't parse (hand-edited history, an older pi)
renders as plain text, as today.

**(call)** The formatter and the parser both live in `shared/src/attachments.ts` (the hub and the app can't
import each other's code, and both need the grammar), with a round-trip test there. The parser also gives a
one-line summary, "the user's text · 2 files", for every place that shows a user message as a line of text:
session titles (`hub/src/sessions.ts` `firstPrompt`, `push-watch.ts` and `pi-session.ts` `sessionTitle`), the
watch's turn stream (`watch-sessions.ts` `turnsFrom`), the composer's queued-message chips (a steer with a file
would otherwise show the whole block) and the fork sheet. A files-only message is titled by its first file's
name, not "Attached:".

**＋ menu.** A new row `attach file` with a paperclip icon (Lucide `paperclip`) right under `attach image`, in
`chat-menu.ts` `menuRows`. It is always shown; `attach image` keeps its `canImages` condition. Both call the
composer's picker: `pickImages()` becomes `pick("image" | "file")` and the composer carries two hidden inputs,
one with `accept="image/*"` and one without `accept`.

**Drop.** `pi-session` and `pi-new-chat` listen for `dragenter`/`dragover`/`dragleave`/`drop` on their host. While
a drag with files is over the page, a full-view overlay says "drop to attach" (dashed border, the primary colour
at low alpha, the same look on both pages). A drop calls the composer's `addFiles(files)`. `dragover` always
calls `preventDefault` so the browser never navigates to the file. The overlay uses a depth counter, since
`dragleave` fires on every child.

**Paste.** The composer's textarea gets a `paste` listener: when `clipboardData.files` is non-empty, those go to
`addFiles` and the default paste is prevented; otherwise the paste proceeds as text. (There is no paste handling
today, for images either, so this is new for both.)

**Routing.** `addFiles` only checks the caps (over-cap files are refused with a toast naming the cap, like the
image toast today) and keeps everything in one `attachments` list; the chip row shows images as thumbnails and
other files as chips in the order added. At submit time a file whose type passes `checkImageFile` goes to
`images` when the model has vision, otherwise to `files` (**(call)**; the composer gets a `canImages` property
for this). Everything else goes to `files`. The ＋ menu's `attach image` row still uses the image-only checks and
toast it has now.

### State that carries files

Everywhere `images: ImageInput[]` travels, `files: FileInput[]` travels with it: `SubmitDetail`, `Draft`,
`Handoff`, the composer's `restore()`, and `pendingPrompt` in `pi-session.ts`. The new-chat page already keeps the
draft when the user leaves and comes back; files are kept the same way (in memory, one per tab, not persisted).

### Limits and errors

| What | Limit | Where enforced | On breach |
|---|---|---|---|
| One file | 20 MB raw | app `addFiles`; hub on decode | toast "Files up to 20 MB can be attached." / `command_error` |
| Files per message | 40 MB raw total | app `addFiles` | toast "Up to 40 MB of files per message." |
| Inlined text | 32 KB, UTF-8, no NUL | hub | saved only, list line says "saved" with no inline note |
| Request body | 64 MB | hub `MAX_BODY` | 413 as today |

Disk-full or an unwritable uploads dir is a `command_error` for the prompt, and the app restores the message in
the composer as it does for any failed send.

**(call)** A message with files whose text is a bash line (`!…`) or an app builtin (`/model`, `/compact`, …)
never reaches the prompt path (`pi-session.ts` `send()` branches on `parseInput`), so the composer refuses to
send it: toast "Files can only go with a message to pi.", nothing cleared.

**(call)** In `semi` approval mode, `read`/`grep`/`find` inside the uploads root count as benign
(`hub/src/auto-approve.ts` `benignTool` gets the uploads root beside the session cwd), so pi reading a PDF Michael
just attached doesn't raise a permission dialog and a "needs you" push. Anything else on those files (pdftotext,
python) is approved as today.

**(call)** Image-or-file routing happens at submit time, not when the file is added: on the new-chat page the
model isn't known until `/api/defaults` answers, and an early drop would otherwise send a PNG as a file to a model
that can see it. Until then the composer holds both kinds in one `attachments` list and splits it in `submit()`.

### Tests

- `shared/src/attachments.test.ts`: the formatted block round-trips through the parser; a message without a
  block; a block with no inlined files; a truncated block parses as plain text; the one-line summary.
- `hub/test/attachments.test.ts`: naming and collisions, text detection (binary, >32 KB, bad UTF-8, a file with
  the closing tag), the cap on decoded size, the commands route rewriting a prompt for both handle kinds.
- `hub/test/auto-approve.test.ts`: a read inside the uploads root is benign in `semi`, one outside it is not.
- `app/src/render/chat-menu.test.ts`: the `attach file` row is there regardless of `canImages`.
- `app/src/components` tests for the composer's `addFiles` routing (image with and without vision, over-cap, total
  cap) if the composer has component tests today; otherwise a pure `routeFiles()` helper in `app/src/lib/files.ts`
  with its own tests.
- `hub/test/translate.test.ts` or `rpc-handle` tests: a prompt with files writes them and sends the rewritten text.
- e2e (`app/e2e/smoke.spec.ts`): attach a small text file through the hidden input, send, and see the chip in the
  user message.

## What's left to the builder

- Exact chip markup and the paperclip icon path.
- The size formatter (`KB`/`MB`, one decimal) and whether the kit already has one.
- Whether `addFiles` reads files with `FileReader` as the image path does or with `File.arrayBuffer()`.
- The e2e selectors.
