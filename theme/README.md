# @thatsit/theme

Fonts and color tokens for apps on thatsit.app, cloned from `@thatsit/ui`
(`src/styles/root.css`). It's one plain CSS file plus its fonts: no build step,
no framework.

## Use it

From any page, link the published copy (pi-web serves it, with CORS open for fonts):

```html
<link rel="stylesheet" href="https://pi.thatsit.app/theme/theme.css" />
```

Or copy this folder next to your app and link `theme/theme.css`. Inside this
repo, import it: `@import "@thatsit/theme/theme.css";`.

Then use the variables:

```css
body { background: var(--bg); color: var(--text-primary); font-family: var(--font-body); }
h1 { font-family: var(--font-display); }
a, :focus-visible { color: var(--primary); outline-color: var(--primary); }
.error { color: var(--accent); }
```

## Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--primary` | #ffaa00 | same | amber: links, focus, selection, primary buttons (black text) |
| `--accent` | #e4002b | same | red: errors, alerts, things that need attention |
| `--secondary` | #0032a0 | same | blue |
| `--success` | #00843d | same | green |
| `--bg` | #f1f1f1 | #171717 | page background |
| `--surface` | #aaaaaa | #555555 | raised surfaces |
| `--text-primary` | #000 | #fff | body text |
| `--text-secondary` | #555 | #a1a1aa | secondary text |
| `--text-muted` | #64748b | #94a3b8 | labels, hints |
| `--border-color` | #555 | #555 | borders |
| `--underline-color` | #646464 | #646464 | link underlines |
| `--shadow-color` | 10% black | 30% black | shadows |
| `--code-bg` | #f1f5f9 | #1e293b | code blocks |
| `--ring` | 30% amber | 40% amber | focus rings |
| `--font-display` | Nunito | | headings, labels |
| `--font-body` | Inter | | body |
| `--font-quote` | Work Sans | | quotes |
| `--font-mono` | system monospace | | code |

## Dark mode

Dark follows the system. To force a theme, set `data-theme="light"` or
`data-theme="dark"` on `<html>` (before first paint, to avoid a flash).

## Fonts

Inter, Nunito and Work Sans are variable fonts under the SIL Open Font License 1.1.
