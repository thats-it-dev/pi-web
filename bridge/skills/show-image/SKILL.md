---
name: show-image
description: Use when you make or find an image Michael would want to see, such as a screenshot, chart, diagram or rendered page, or when he asks to see something visual.
---

# Show an image

`show_image` puts an image file in the conversation, as a figure in your reply in pi-web.

## When

- You made visual output: a screenshot, a chart, a rendered page, a diagram.
- Michael asks to see something that is, or can become, an image.
- Don't use it for text. Say text in your reply.

## How

1. Save the image to the working directory or a temp dir. PNG, JPEG, GIF and WebP work.
2. Call `show_image({ path, caption? })`. A short caption helps.
3. The file must be 2 MB or smaller. Shrink bigger ones first, with `python3` and PIL, or `convert in.png -resize 50% out.png`.
4. If you have already looked at the image, pass `see: false`. It then stays out of your context.

## Recipes

- Emulator: `pebble screenshot --emulator emery --no-open f.png`
- The watch: follow the `pebble-phone-dev-connection` skill, then show the file it saves.
- A web page: Playwright's `page.screenshot({ path: "f.png" })`
