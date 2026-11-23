---
name: preview
description: Use when you changed how a web app or page looks, or made an HTML mockup or prototype, and Michael should see it live before any PR; and when he asks to "show me", "let me see it" or "open the preview".
---

# Preview

`preview` opens a live page in pi-web, so Michael looks at the real thing instead of reading about it.

## When

- The first visual change to an app.
- A mockup or prototype, before you write the real code.
- Before `pr`.
- Michael says "show me" or "let me see it".

## How

1. For an app, call `preview({ cwd })`. For a mockup, call `preview({ dir })` or `preview({ file })`.
   No mockup folder yet? Call `preview({})` first. It returns the scratch folder to write into.
2. Tell Michael in one line that the preview is open, then end your turn.
3. Edits live-reload. Don't call it again for the same app.
4. Call `preview({ stop: true })` only when he says he is done, or before you switch to another app.

## What Michael sees

- Desktop and iPad: a Preview tab beside the chat, with fit, 390 and 768 widths.
- Phone: an Open button that opens his browser.

## Don't

- Don't screenshot the preview for him. He looks himself.
- Don't open a PR before he has looked, unless he waved it off.
- Never make up a URL. The tool returns it.
