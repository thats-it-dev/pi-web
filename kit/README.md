# @thatsit/kit

Shared building blocks for thatsit.app apps: `sharedStyles` (Lit), `toast()`, viewport tracking, `kit.css` (tokens and page base, imports `@thatsit/theme`) and `theme-init.js`.

`theme-init.js` reads its localStorage key from `data-key` on its script tag and defaults to `thatsit:theme`:

```html
<script src="/theme-init.js" data-key="my-app:theme"></script>
```

The API is additive-only: exports, CSS custom properties and published files are never removed or renamed.

## Using the kit by URL

Everything is published at https://kit.thatsit.app/ with `access-control-allow-origin: *`. A page loads the built files directly:

```html
<link rel="stylesheet" href="https://kit.thatsit.app/kit.css">
<script src="https://kit.thatsit.app/theme-init.js" data-key="my-app:theme"></script>
<script type="module">
	import 'https://kit.thatsit.app/kit.js';
</script>
```

- `kit.css` holds the tokens and page base. `theme-init.js` sets the theme before first paint; `data-key` picks its localStorage key.
- `kit.js` imports only `./lit.js`, so a page that also needs Lit should import `https://kit.thatsit.app/lit.js` too. Keep exactly one copy of Lit per page, because two copies break custom-element registration and `instanceof` checks.
- `lit.js` re-exports `lit`, `lit/directives/unsafe-html.js` and `lit/directives/guard.js` only (more directives can be added). The published API surface is exactly what `api.json` lists.
- `kit.d.ts` and `types/` hold the typings, `api.json` lists the public API.

## Shell vs. document pages

`kit.css` only locks the document (no scroll, no bounce, full height) when `<html data-shell>` is set, as pi-web's app shell does. Pages without it scroll normally.

## Side panels

`tk-shell` has two side panels next to the main area. Put content in the `nav` slot for the left panel (page list, navigation) and in the `aside` slot for the right panel (details, context for the current page). Everything else goes in the default slot.

```html
<tk-shell store-key="my-app:panels" aside-label="Details">
	<nav slot="nav">...</nav>
	<section slot="aside">...</section>
	<div>
		<tk-header aside-badge="3">
			<h1 slot="title">Inbox</h1>
		</tk-header>
		...
	</div>
</tk-shell>
```

An empty slot means no panel: no column, no landmark and no header button. Existing apps need no changes, but they look a little different:

- A shell with neither slot filled no longer draws an empty 280px column on desktops or shows a menu button that opens an empty drawer on phones.
- A shell with a nav panel gets a panel button on desktops too, left of the title, so the title moves right. The phone menu button draws a menu icon instead of the ☰ character.
- The phone nav drawer is `min(85vw, 360px)` wide instead of `min(80vw, 360px)`, and its shadow uses `--shadow-color`.

### Breakpoints

- Phone (`max-width: 899px`): both panels are drawers. A drawer slides in over the page, with a dimmed overlay behind it.
- Both panels, 900px to 1199px: navigation is a docked column and details is a drawer.
- Both panels, 1200px and up: both are docked columns.
- Only details, 900px and up: details is a docked column.
- Only navigation, 900px and up: navigation is a docked column, as before.

Docked columns are `--sidebar-w` (280px) and `--aside-w` (300px) wide. Drawers are at most 85vw or 360px wide.

### Hiding and showing

On a desktop a docked panel can be hidden with its button in `tk-header`. The header shows a left button when there is a nav panel (a panel icon while docked, a menu icon on phones) and a right button when there is an aside panel. Both set `aria-expanded`.

- `nav-hidden` and `aside-hidden` (attributes, reflected, `boolean`): the panel starts hidden. Set them in markup to make a panel default-hidden.
- `store-key` (attribute, `string`): a localStorage key. When set, the hidden state of both panels is saved there and restored on load, and it overrides `nav-hidden` and `aside-hidden`. Without it nothing is stored. On phones the hidden state has no effect, because panels are drawers there.

### Drawers

- Tapping the overlay or pressing Escape closes the open drawer.
- Opening a drawer moves focus into it. Closing it moves focus back to where it was.
- A closed drawer is inert, so it cannot be tabbed into. While a drawer is open, the rest of the page is inert too.
- The nav drawer closes when you follow a link or the hash changes. The details drawer stays open, because it belongs to the page.
- Resizing so that a drawer would dock closes it.

### Sheets over drawers

A `tk-sheet` opened while a drawer is open stays usable, even if the sheet lives inside the page or the drawer. Escape closes the sheet first and the drawer stays. A second Escape closes the drawer.

### API

`tk-shell`:

- `nav-label`: `string`, default `"Navigation"`. The label of the left landmark.
- `aside-label`: `string`, default `"Details"`. The label of the right landmark.
- `store-key`: `string | null`, default `null`. See above.
- `nav-hidden`, `aside-hidden`: `boolean`, default `false`. See above.
- `navOpen`: `boolean` property. Whether the nav drawer is open. Set it to open or close the drawer.
- `asideOpen`: `boolean` property. Whether the details drawer is open. Set it to open or close the drawer.
- Only one drawer is open at a time: opening one, by property or method, closes the other. Prefer `show`, `hide` and `toggle`, which also work on docked columns.
- `show(panel)`, `hide(panel)`, `toggle(panel)`: methods, where `panel` is `"nav"` or `"aside"`. They show, hide or toggle a docked column, or open or close a drawer. They do nothing for an empty panel.
- `tk-panel-change`: event on the shell (bubbles, composed). `detail` is `{ panel: "nav" | "aside", open: boolean, docked: boolean }`. It fires when a panel opens, closes, docks or undocks, not on first render.

- `tk-show-panel`, `tk-hide-panel`, `tk-toggle-panel`: events the shell listens for. Dispatch them from anywhere inside the shell (`bubbles: true, composed: true`) with `detail` `{ panel: "nav" | "aside" }`. They call `show`, `hide` and `toggle`. An event with a missing or unknown panel is ignored. `tk-open-nav` is accepted too and means `show("nav")`. For example, a hide button in the aside's own top row:

```html
<button onclick="this.dispatchEvent(new CustomEvent('tk-hide-panel', { detail: { panel: 'aside' }, bubbles: true, composed: true }))">Close</button>
```

`tk-header`:

- `menu-label`: `string`, default `"Open menu"`. The label of the left button.
- `aside-label`: `string`, default `"Details"`. The label of the right button.
- `aside-badge`: `string`, default empty. A short text (a count, for example) shown as a badge on the right button.
- `tucked`: `boolean`, as before.
- `panels`: `PanelsState | null` property, set by the enclosing shell. It is `null` outside a shell, where the header keeps its old phone-only menu button.
- `tk-toggle-panel`: event the header sends when a panel button is pressed (see above). `tk-open-nav` is still sent when the nav panel opens.
- `tk-header-connect`: event the header sends when it connects, so the shell can hand it the panel state. `detail` is `{ header }`.

`tk-sheet`:

- `tk-sheet-toggle`: event sent on open and close. `detail` is `{ open: boolean }`. The shell uses it to keep sheets usable over drawers and to give Escape to the sheet first.

### Shared classes

`sharedStyles` now has `.icon-btn` (a 36px square icon button; an `svg` inside is 20px) and `.badge` (a small bordered pill for counts). Use them for your own icon buttons and counts, so they match the header.

### Stacking order

Header 5, overlay 10, drawers 20, sheet scrim 30, sheet panel 31. Anything you add should stay below 5 or have a reason to go above 31.

### Rules

Never build a panel, drawer, scrim or panel toggle yourself. Use the `nav` and `aside` slots and `tk-header`. Hand-made versions miss the breakpoints, focus handling, Escape and stacking order above.

## API policy

The API is additive-only: exports, element tags (`tk-`), events, CSS custom properties and published files are never removed or renamed. `npm run check-api -w kit` fetches `https://kit.thatsit.app/api.json` and fails if the fresh build dropped anything the live kit has. CI runs it before every deploy.

## Publishing

CI (`.github/workflows/kit.yml`) runs on pushes to `master` that touch `kit/`, `theme/` or the workflow: build, test, check-api, then

```sh
npx wrangler@4.149.0 pages deploy kit/dist --project-name thatsit-kit --branch master
```

with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the org secrets. `cf` 1.0.0-beta.14 has `cf pages deploy`, but it is a stub that only prints "Legacy Pages is not supported", so wrangler is used for the upload and nothing else. `cf` handles project creation and the domain.

### One-time setup

```sh
cf auth login
cf pages create --name thatsit-kit --production-branch master
cf pages domains create thatsit-kit --name kit.thatsit.app
```

Add a CNAME `kit` -> `thatsit-kit.pages.dev` in the thatsit.app zone if cf did not. Then create an API token with "Cloudflare Pages: Edit" and store both values as org secrets:

```sh
gh secret set CLOUDFLARE_API_TOKEN --org thats-it-dev --visibility all
gh secret set CLOUDFLARE_ACCOUNT_ID --org thats-it-dev --visibility all
```

Check: `curl -sI https://kit.thatsit.app/kit.css` returns 200 with `access-control-allow-origin: *`.
