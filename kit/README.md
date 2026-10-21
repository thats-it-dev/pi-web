# @thatsit/kit

Shared building blocks for thatsit.app apps: `sharedStyles` (Lit), `toast()`, viewport tracking, `kit.css` (tokens and page base, imports `@thatsit/theme`) and `theme-init.js`.

`theme-init.js` reads its localStorage key from `data-key` on its script tag and defaults to `thatsit:theme`:

```html
<script src="/theme-init.js" data-key="my-app:theme"></script>
```

The API is additive-only: exports, CSS custom properties and published files are never removed or renamed.
