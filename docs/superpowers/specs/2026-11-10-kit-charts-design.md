# Kit charts: data visualization that looks like the kit

Date: 2026-11-10 · Repo: `thats-it-dev/pi-web` (kit in `kit/`, skill in `skills/thatsit-app/`) plus `thats-it-dev/app-template` (`~/workspace/app-template`) · Mockups: `2026-11-10-kit-charts-mockups/` next to this file (open the `.html` files in a browser, or see the `.png` screenshots). `density.html` panel **B** is the approved look, and `secondary-color.html` option **2** is the approved second color.

## Why

thatsit apps are starting to show data, and the kit has nothing for it. keeb, the first app to need charts, hand-built its own in the stats side panel:

- `src/stats/history-section.ts` is a d3-scale/d3-shape SVG line chart. It shows typing speed per day with a goal line, gaps for days without practice, a second "typing only" line, and a shaded band between the two lines.
- `src/stats/progress-section.ts` draws one bar per key against a goal tick.
- `src/ui/card.ts` draws the stat cards.

Michael's verdict on them: they **don't look like the kit**, they are **hard to read** (for example, 7–8px text inside a scaled `viewBox`), and **each app hand-rolls too much code**. Every future pi-built app with numbers would repeat all three problems.

The kit should own charts the way it now owns side panels. Apps hand it rows of data, and the kit draws something that looks like part of pi-web and reads well in a 300px sidebar.

Look at keeb's code as a reference. **Do not change keeb**: migrating it is a later pi task, and Michael fixes apps through pi, not by hand.

## Goals

1. **Five kit components** for the first set:
   - stat tiles
   - a sparkline (used inside tiles)
   - a time series chart
   - a bar list against a target
   - a calendar heatmap
2. **They look like the kit:** Nunito, kit tokens only, nearly square corners (`--radius`), light and dark mode for free. The approved density is mockup **B ("Roomy")**.
3. **They are built for a narrow column.** The design target is the kit's `--aside-w` (300px) details panel, with ~270px of content width. Everything must still work from ~240px up to a full-width page. The width comes from the container, never a fixed width or a `viewBox` scale.
4. **They are readable at a glance:** real-pixel text at 12px minimum, axis titles left out on purpose (Michael is fine without them), sparing direct labels, and a goal/reference line where an app has one.
5. **Hover, drag and keyboard show a "readout in place"** (described under Interaction below).
6. **They are drop-in:** an app passes its own rows plus a few attributes and gets a finished chart, with no d3, no SVG and no scales in app code.
7. **pi uses them.** The thatsit-app skill and the template's AGENTS.md/README tell pi to use the kit charts and never hand-roll chart SVG or d3.

## Non-goals

- Changing keeb, or any app under `~/workspace/apps`.
- A general charting library. There is no pie/donut chart, scatter plot, stacked bars, maps, zooming or brushing, and no dual-axis charts ever.
- Adding d3 (or any charting dependency) to the kit. The kit depends only on Lit and is loaded by URL.
- Animations beyond a short fade/transition on data change, which is optional.

## Anti-goals (fail even if it works)

- A chart that looks like a library default (Chart.js/Recharts styling) dropped into a kit page.
- Text smaller than 12px, or text that scales with the chart's width.
- A floating tooltip that covers the data in a narrow panel.
- Chart colors hard-coded in app code, or text drawn in a series color (labels, values and legends always use text tokens).
- Any change that breaks the kit's additive-only API. Exports, tokens and published files are never removed or renamed (see `api.json` / `check-api`).

## The look (mockup B)

Shared across all components:

- **Font:** inherits `--font-body` (Nunito).
  - Chart text is 12px in `--text-secondary`.
  - Values in the readout and tiles are `--text-primary`.
  - Tabular figures are used only where numbers line up in a column (gridline values, bar values).
- **Lines:**
  - Gridlines and baselines are a 1px `--line` hairline, solid.
  - The goal/reference line is 1px `--text-primary` at ~55% opacity, with a 12px bold label "goal N" in `--text-secondary` at the **left** end, just above the line.
  - Data lines are 2px with round joins and caps.
  - End markers are r=4 with a 2px ring in the surface color.
- **Section headings** are not drawn by the charts. The app supplies them (keeb uses small lowercase headings, as kit's `.label` does).
- **Background:** the charts sit directly on the panel background. Stat tiles use `--panel` as their fill.

### Stat tiles (`tk-stat`, plus a grid)

- Label (sentence/lowercase, no colon) above a 24px bold value. `--text-secondary` label, `--panel` fill, `--radius` corners, ~8px × 10px padding.
- **Tiles sit two to a row.** One tile can span both columns. The span-two tile can carry:
  - a sparkline on the right (~110 × 40),
  - a change line under the value, e.g. "+5 vs previous 2 weeks". The change line is plain text in `--text-secondary` and never colored, because the kit has no up-is-good/up-is-bad knowledge.
- **Values are compact:** 1,284 / 18.4K / 312 min, with proportional figures.
- **Grid layout:** a two-column grid with a 6px gap and an option to make one tile span both columns. Whether that is a small `<tk-stats>` container element or a `sharedStyles` class is the builder's call. Note that `sharedStyles` only reaches into shadow roots, and apps render inside their own components, so a class works there.

### Sparkline (`tk-sparkline`)

- A single 2px series line in `--chart-1` with an end dot.
- No axes or text.
- Sized by its container or by attributes.
- Usable alone or inside a tile.

### Time series (`tk-timeseries`)

- **Size:** about 140px tall by default, with the height configurable. Width comes from the container.
- **Gridlines:** 3–4 "nice" hairline gridlines, with their values at the **right** edge (12px).
- **Dates:** only the first and last dates appear, under the chart at the left and right edges.
- **No axis titles.**
- **Gaps:**
  - When x is a calendar day, a day with no value **breaks the line** instead of bridging it. Each day keeps its slot on the x axis, as keeb's `scaleBand` over day keys does, so the empty space is real.
  - An explicit `null` or missing y value also breaks the line.
- **Series:**
  - One series by default (`--chart-1`), up to four.
  - Two or more series get a small legend row under the chart, with a short line swatch plus text in `--text-secondary`. A single series gets no legend.
- **Optional band:** a shaded band between two named series, the series color at ~12% opacity. The band breaks where either series has no value. keeb's "time spent not typing" band is the use case, and the band can get its own legend entry.
- **Optional goal:** a goal/reference value draws the goal line described above.
- **Y domain:** "nice" bounds that include the goal. The y axis need not start at zero for lines, as the mockup shows, so a 30–45 wpm wobble stays visible.

### Bar list (`tk-bars`)

- Each row is two lines:
  - first, the label in bold `--text-primary` on the left and the formatted value on the right (`--text-secondary`, tabular);
  - second, an 8px tall bar on a track. The track is `--panel` and fully rounded.
- **Rows:** ~8px apart. The rows share one scale.
- **Goal:**
  - An optional goal draws a 2px `--text-primary` tick across every track, at the same x on every row.
  - Bars at or past the goal fill `--chart-1`, and bars under it fill `--chart-2`. That's what the approved mockup shows: "under goal" is blue, not grey.
  - Without a goal, every bar is `--chart-1`.
- **Direction:** the goal can mean "higher is better" (wpm) or "lower is better" (ms). The default is higher-is-better, set by an attribute.
  - **A longer bar always means better (Michael's call).** For lower-is-better, the kit flips the scale, so a fast key gets a long bar and a slow key a short one. The goal tick sits in the same place as in a higher-is-better list, and "past the tick" always means at goal.
  - The value text stays the raw value ("180 ms").
  - The scale should keep ms values many times the goal readable without clipping everything to zero, so a goal-centred or ratio-based scale (goal/value) is fine. keeb's `barWidth` in `apps/touchtype/src/stats/overview.ts` is a log scale with the goal at 50%, worth reading. The exact scale is the builder's call, as long as the goal tick is at the same x for both directions and the ordering of bars matches the ordering of values.
- **Order:** rows render in the order given, and the app sorts them.

### Calendar heatmap (`tk-heatmap`)

- Weeks are columns and weekdays are rows (7 rows). The number of weeks defaults to 12, or comes from the data's range or an attribute.
- **Cells:**
  - ~18px square with a 4px gap and 2px rounded corners.
  - Width-aware: cells shrink so the grid fits the container, but never go below ~10px. When it doesn't fit, show fewer weeks (the most recent ones) rather than overflowing.
- **Labels:** month labels above the grid (12px `--text-secondary`). There are no weekday labels by default.
- **Color:** a single hue, `--chart-1`, in light-to-dark steps (4 steps). An empty day is `--panel`. A cell with no data and a cell with a zero value both use `--panel`.
- **Legend:** an optional "less ▢▢▢▢ more" legend.

## Color tokens

New tokens go into `kit.css`, each defined for light mode and dark mode. Use the same pattern as the existing `--panel`/`--line`: the `prefers-color-scheme` block guarded by `:root:not([data-theme="light"])`, plus `:root[data-theme="dark"]`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--chart-1` | `#e69500` | `#ffaa00` | the main series, bars at goal, the heatmap hue, sparklines |
| `--chart-2` | `#006eb8` | `#5aa6e6` | the second series, bars under goal |
| `--chart-3`, `--chart-4` | builder | builder | the third and fourth series only |

- **`--chart-1`** is the theme orange. In light mode it is darkened a step, because `#ffaa00` on `#f1f1f1` is ~1.9:1 contrast and washes out. This darkening is my call, and the mockups use it.
- **`--chart-2`** is **Michael's pick**: "Blue" `#006eb8` from Sanzo Wada's *A Dictionary of Color Combinations*, where it is paired with Orange Yellow `#fcb315` (combos 191, 257, 267). The dark value is the same hue made lighter for the dark surface.
- **The theme's red `--accent` (`#e4002b`) and green `--success` (`#00843d`) are status colors in charts, never series colors.** This is Michael's call. Kit and pi-web already use them for warning/error/hot and for ok/done, so a red series would read as "bad". Charts use them only where a value has a good/bad meaning, and always together with a sign, word or icon, never color alone:
  - a stat tile's change line, when the app says which direction is good (e.g. `good="up"`), so "+5" turns green and "−3" turns red. With no `good` attribute the change line stays `--text-secondary` as above. The text still carries the sign.
  - status markers an app explicitly asks for.
  - They are *not* the at-goal/under-goal bar fill. That stays `--chart-1`/`--chart-2`, as approved in the mockup.
  - Validation: red and green pass against orange and blue in both modes, but red↔green is only 7.9 for deuteranopes (the floor band). So they never appear as the only difference between two marks.
- **`--chart-3` and `--chart-4`** should also come from Wada combinations that use an orange near `#ffaa00`, not from the theme's red or green. Combo 257 pairs Orange Yellow and Blue with Aconite Violet `#a36aa5`, and combo 286 has Peacock Blue `#00939b`.
  - Each slot needs a lighter dark-mode version.
  - The full set must pass the dataviz validator (below) for adjacent colorblind separation in both modes.
  - Slots are assigned to series in a fixed order and never cycled. A fifth series is an error (console warning, not drawn) rather than a generated color.
- **Validation:** check every palette with the dataviz skill's validator, `node scripts/validate_palette.js "<hex,…>" --mode light --surface "#f1f1f1"` and again with `--mode dark --surface "#171717"`, relative to the skill's base directory. Paste the result in the PR.
  - Orange's lightness-band FAIL in dark mode is accepted, because `#ffaa00` is the brand color.
  - The light-mode contrast WARN on orange is answered by the readout and the accessible table.
- **Wash colors:** the band and heatmap steps come from the series token via `color-mix()` or opacity, never as new hard-coded hex values.
- **Overrides:** apps may override the tokens, as with any kit token. They should not need to.

The full ramps are worth keeping in the PR description. Wada partners of kit orange considered and passed over:

- Violet `#4f4086`
- Peacock Blue `#00939b`
- Rosolanc Purple `#b73f74`
- greens and Burnt Sienna, rejected for colorblind separation from orange.

## Interaction: readout in place

Michael chose this over floating tooltips.

- **Where it sits:** every chart with a plot (time series, bars, heatmap, sparkline only when interactive) has a one-line **readout** directly above the plot, 12–13px.
  - At rest it shows the latest point, or a summary for bars and heatmaps (builder's call), e.g. "Nov 9 · 36 wpm · typing only 44".
  - While it's active, it shows the hovered point.
- **Time series:**
  - Pointer hover or a touch drag snaps a vertical hairline crosshair to the nearest x slot and rings the markers on each series at that x.
  - The readout shows the date and each series' value, with series swatches, because text never wears the series color.
  - Leaving or lifting returns to the rest state.
  - The touch drag must not fight the panel's vertical scroll. Horizontal drags scrub the chart, and vertical drags scroll the panel (`touch-action: pan-y`).
- **Bars and heatmap:** the hovered or touched row or cell highlights (the others dim a little, or the cell gets a ring) and the readout shows its label/date and value.
- **Hit targets** are bigger than the marks: the whole x slot for a time series, the whole row for bars, and the cell plus its gap for the heatmap.
- **Keyboard:**
  - The plot is focusable (`tabindex="0"`), and Left/Right step through points, rows or days, with Up/Down by week on the heatmap.
  - Home/End jump to the first or last point. Escape returns the readout to rest.
  - Focus shows the kit's focus ring (`--ring`).
- **Readout events:** the readout text is in an `aria-live="polite"` region, throttled so scrubbing doesn't spam a screen reader. The component also fires a bubbling `tk-readout` event with the active datum, so an app can react (e.g. highlight the same key elsewhere). Whether to add that event is the builder's call; it is additive.

## Accessibility

- Every plot has `role="img"` and an `aria-label` with a generated text summary, like keeb's: count, range, latest, best, goal. An attribute lets the app supply its own summary.
- **A table view.** Each chart can render its data as a visually hidden `<table>`, or as a visible one behind a small "table" toggle (builder's call on the exact UI; the default is visually hidden), so nothing is color-only or hover-only.
- `prefers-reduced-motion` turns off any transitions.
- `forced-colors` keeps lines and bars visible (use `CanvasText`/`Highlight` as fallbacks).

## API shape

The API is a sketch. The builder can adjust names, but must keep the principles: plain rows in, field names as attributes, kit look out.

```html
<tk-timeseries
  .data=${sessionsByDay}          <!-- array of plain objects -->
  x="day"                          <!-- field: "YYYY-MM-DD" string, Date, or ms -->
  .series=${[{ y: "wpm", label: "with pauses" }, { y: "strokeWpm", label: "typing only" }]}
  band="wpm strokeWpm" band-label="time spent not typing"
  goal="40" unit="wpm"
  .format=${(v) => `${v} wpm`}></tk-timeseries>

<tk-bars .data=${keys} label="label" value="wpm" goal="40" unit="wpm"></tk-bars>
<tk-heatmap .data=${days} x="day" value="minutes" weeks="12" unit="min"></tk-heatmap>
<tk-stat label="average" value="34" unit="wpm" change="+5 vs previous 2 weeks" .trend=${last14} wide></tk-stat>
<tk-sparkline .values=${last14}></tk-sparkline>
```

- **Inputs:**
  - `.data` takes the app's own row shape, and attributes name the fields, so keeb's `Point[]` goes in unchanged.
  - A simple `y="wpm"` attribute covers the single-series case.
  - A `.format` property overrides number formatting for the readout, bar values and tiles. By default numbers go through `Intl.NumberFormat`, plus the `unit`. Dates go through `Intl.DateTimeFormat` (`month: "short", day: "numeric"`), parsed from day keys at local noon as keeb's `parseDay` does, so no timezone moves a day.
- **Missing values (my call):** a point is missing when its y is `null`, `undefined` or `NaN`. `0` is a real value. Each series (and the single-series `y` form) also takes an optional `defined: (row) => boolean` property. That's how an app says "0 here means not measured" without reshaping its rows. keeb would pass `defined: q => q.sessions > 0` for the clock line and `q => q.sessions > 0 && q.strokeWpm > 0` for "typing only", exactly as its d3 code does today. A band is drawn only where both of its series are defined.
- **The x axis (my call):** x is always a calendar day in this version. `"YYYY-MM-DD"` strings are used as they are, and a `Date` or ms value is bucketed into its local day. The kit gives every day between the first and last row its own slot and fills in the days the data skips, so gaps are real space. If two rows share a day, the last one wins, and the app aggregates. Data finer than a day and continuous time axes are out of scope.
- **Heatmap weeks (my call):** weeks start on Monday (ISO), the same for every locale, so a layout never reshuffles between users. A month label sits over the first column that contains the 1st of that month, and it is left out if it would collide with the previous label.
- **Empty state:** no data renders a quiet one-line message in `--text-secondary`, never a blank box. The text can be overridden by an attribute or slot.
- **Rendering:** components are Lit elements in shadow DOM, styled from kit tokens. They use `sharedStyles` where helpful and size from their container with `ResizeObserver`. The SVG is built in real pixels: no `viewBox` scaling of text.
- **The maths** lives in small pure modules that are unit-tested on their own: the linear scale with `nice()` and `ticks()`, the day-slot/band scale, line and area path builders with gap breaks, compact number formatting, nearest-point lookup and heatmap week layout. Hand-written, with no d3. keeb's comments describe the traps to test for: `.nice()` after setting the domain, `.defined()` gaps, a 0 that means "not measured".

## Shipping in the kit

- **Exports:** register and export the new elements from `src/index.ts`, together with any public types. Run `npm run build` so `dist/api.json` gains the new entries. `check-api` must pass, which means only additions.
- **README:** add a "Charts" section in the style of "Side panels": what each component is for, its attributes and properties, one example each, and the color tokens.
- **Demo:** a charts page or section in `kit/demo/` that shows every component with realistic data in a 300px aside and at full width, in both themes. That includes the two-series + band + goal time series, bars with a goal, the heatmap, the tiles with a wide sparkline tile, and the empty states. Wire it into `scripts/build.ts` like `bare.html`/`shadow.html` if it's a separate page.
- **Tests:**
  - Vitest for the maths modules and formatting.
  - Playwright (`kit/e2e/`) for rendering at 270px and full width: no horizontal overflow, text ≥ 12px, the readout updates on hover, keyboard stepping, a touch drag (emulated), both themes, and a screenshot or two for the PR.
- **Size:** the bundle size of `kit.js` goes up, and the PR should say by how much. The kit has no lazy-loading today, and adding it is out of scope.

## Teaching pi

- `skills/thatsit-app/SKILL.md`, in the "use only kit components" rule (~line 124): add `tk-stat`, `tk-sparkline`, `tk-timeseries`, `tk-bars` and `tk-heatmap`. Say to show numbers and charts with them, never to hand-build chart SVG, canvas or d3, and to see the kit README "Charts".
- `~/workspace/app-template/AGENTS.md`, under the styling and side panel rules (~lines 75–81): the same rule, one or two lines. The template README "Rules" gets a pointer if it lists components.
- The template changes reach existing apps through `thatsit-app sync-template`. That is also how keeb gets the rule, but keeb's migration is a separate pi prompt, not part of this work.
- The skill and template live in different repos. That means two commits/PRs, and the template one is merged by Michael.

### Order and deploy

Pushing kit to master deploys it to kit.thatsit.app (`.github/workflows/kit.yml`), and apps fetch their kit types from the live `kit.d.ts`. So the order is (my call):

1. The kit change is merged and deployed.
2. Check that `check-api` passes and that the live `kit.d.ts` and `api.json` list the new elements.
3. Only then do the skill and template rules land. Otherwise pi would reach for components that don't exist yet.

Merging and pushing need Michael's go-ahead, as usual. The plan stops and asks at each push.

## Constraints

- **Additive only:** kit API, tokens and published files.
- **Dependencies:** none beyond Lit, which is loaded from `https://kit.thatsit.app/lit.js` by apps, one copy per page.
- **Shadow DOM:** the components work inside other components' shadow roots, which is how every thatsit app renders.
- **Placement:** they work inside `tk-shell`'s `aside` drawer on phones (the drawer is ≤ min(85vw, 360px)).

## Left to the builder

- Exact component and attribute names, within the sketch above.
- Whether the tile grid is an element or a class.
- What the readout shows at rest for bars and heatmaps.
- Whether the table view is visually hidden only, or togglable.
- The `--chart-3`/`--chart-4` values, from Wada and passing the validator.
- The heatmap step count (3–5) and how cells shrink.
- The default heights.
- Whether to add the `tk-readout` event.
- How the demo is organised.
