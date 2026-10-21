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
- `lit.js` re-exports `lit` and `lit/directives/unsafe-html.js` only (more directives can be added). The published API surface is exactly what `api.json` lists.
- `kit.d.ts` and `types/` hold the typings, `api.json` lists the public API.

## Shell vs. document pages

`kit.css` only locks the document (no scroll, no bounce, full height) when `<html data-shell>` is set, as pi-web's app shell does. Pages without it scroll normally.

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
