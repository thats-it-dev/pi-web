# Kit Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five kit chart components (`tk-stat` + `tk-stats`, `tk-sparkline`, `tk-timeseries`, `tk-bars`, `tk-heatmap`). They look like the kit, read well in a 300px side panel and take an app's own rows. Then teach pi to use them.

**Architecture:**
- Pure, unit-tested maths modules in `kit/src/charts/` (scales, day slots, paths, formatting, bar scale, heatmap layout).
- A shared `ChartBase` Lit element owns width tracking, the readout line, keyboard stepping, the live region and the hidden table.
- Each component is a thin Lit element that renders real-pixel SVG in its shadow root, using kit tokens only.
- A demo page (`demo/charts.html`) is both the showcase and the Playwright fixture.

**Tech Stack:** TypeScript, Lit 3.3.3 (already the kit's only dependency), Vitest (node environment), Playwright (desktop + Pixel 7 projects against the built `dist`). No d3.

**Spec:** `docs/superpowers/specs/2026-11-10-kit-charts-design.md`. The mockups are in `docs/superpowers/specs/2026-11-10-kit-charts-mockups/`: `density.html` panel B is the look, and `secondary-color.html` option 2 is the second color. Read the spec before every task.

## Global Constraints

- **Additive only.** Never remove or rename an export, element, attribute, event, CSS custom property or published file. `npm run check-api -w kit` must report only additions.
- **Dependencies:** none new. `kit.js` must still import only `./lit.js` (`test/dist.test.ts` enforces this).
- **Text:** every chart text is real pixels, ≥ 12px. No `viewBox` scaling of text. Width comes from the container (`ResizeObserver`), never from a fixed width.
- **Colors** come only from tokens: `--chart-1` (light `#e69500`, dark `#ffaa00`) and `--chart-2` (light `#006eb8`, dark `#5aa6e6`), plus `--chart-3`/`--chart-4` from Task 1.
  - Text uses `--text-primary`/`--text-secondary` only, never a series color.
  - Washes (band, heatmap steps) are derived with `color-mix()`/opacity from a series token.
- **Red and green are status colors, never series colors.** `--accent` `#e4002b` and `--success` `#00843d` appear only on a `tk-stat` change line when `good` is set, and always with the sign in the text.
- **Line and mark specs:**
  - Gridlines and baselines: 1px solid `--line`.
  - Data lines: 2px with round join and cap.
  - End marker: r=4 with a 2px ring in the surface color.
  - Goal line: 1px `--text-primary` at 55% opacity, labelled "goal N" (12px bold, `--text-secondary`) at its left end, just above the line.
  - Bar track: 8px tall, `--panel`, fully rounded.
  - Goal tick on bars: 2px `--text-primary`.
- **Missing values:** a y value of `null`, `undefined` or `NaN` is missing, and `0` is a value. A per-series `defined(row)` overrides this.
- **The x axis is always a calendar day.** `"YYYY-MM-DD"` keys are used as they are, and a `Date` or ms is bucketed into its local day. Every day from the first to the last gets a slot. When two rows share a day, the last one wins.
- **Heatmap weeks** start on Monday (ISO) in every locale.
- **Bars:** a longer bar always means better. For `lower`, the scale flips and the value text stays raw.
- **Interaction is a readout in place:** a one-line readout above the plot, with no floating tooltip.
  - `touch-action: pan-y` on plots.
  - Keyboard: Left/Right step, Up/Down step by 7 on the heatmap, Home/End jump, Escape returns to rest.
  - The live region is `aria-live="polite"`, throttled to at most one update per 400 ms.
- **The kit's style:** tabs for indentation, `.ts` import extensions, `static properties` + `declare` fields (see `kit/src/tk-sheet.ts`), and `customElements.define("tk-…", Class)` at the bottom of each element file. The API surface parser relies on that last literal.
- **Don't touch:** keeb and `~/workspace/apps/*`.
- **Committing and pushing:** commit after each task on branch `feat/kit-charts` in pi-web, which already holds the spec commit. **Never push or merge without Michael's explicit go-ahead.**

## Review Focus

1. **A single row, or every row on one day:** the time series must draw one visible point (a round-capped zero-length segment plus the end marker), not an empty path or a NaN in `d`. A test for this is in Task 2 (`linePath`) and Task 6 (e2e).
2. **All values equal (flat line) or all values missing:** the y domain must not collapse to zero height (no division by zero), and all-missing renders the empty state. A test is in Task 2 (`seriesDomain`).
3. **A date range across a DST change:** day slots must step by calendar date, so 2026-03-08 and 2026-11-01 (US) appear exactly once and nothing is skipped. A test is in Task 2 (`daySlots`).
4. **A very narrow container (240px) or a resize while hovered:**
   - The heatmap drops the oldest weeks instead of overflowing.
   - The readout's active index stays valid after `.data` shrinks.
   - Tests are in Task 3 (`fitWeeks`) and Task 5 (active index clamped on data change).
5. **A touch drag inside the scrolling aside drawer on a phone:** a horizontal drag scrubs and a vertical drag scrolls the panel. A test is in Task 6 (e2e, phone project).

---

### Task 1: Chart color tokens

**Files:**
- Modify: `kit/src/kit.css`. Add the tokens to the `:root` block, the `prefers-color-scheme: dark` guarded block and the `:root[data-theme="dark"]` block.
- Modify: `kit/test/dist.test.ts`, extending the "kit.css is self-contained" test or adding one next to it.
- Create: `docs/superpowers/specs/2026-11-10-kit-charts-mockups/palette.md`, the validator output kept for the PR.

**Interfaces:**
- Produces these CSS custom properties: `--chart-1`, `--chart-2`, `--chart-3` and `--chart-4`, each defined for light and dark.

- [ ] **Step 1: Pick `--chart-3`/`--chart-4`.**
  - **Candidates:** Wada colors from combinations that contain Orange Yellow `#fcb315` or Yellow Orange `#f99d1b`. The dataset is `https://raw.githubusercontent.com/mattdesl/dictionary-of-colour-combinations/master/colors.json`; download it into its own scratch dir.
  - **Validator:** the dataviz skill's `scripts/validate_palette.js`. Run it with `"<c1>,<c2>,<c3>,<c4>" --pairs all`, once with `--mode light --surface "#f1f1f1"` (c1=`#e69500`, c2=`#006eb8`) and once with `--mode dark --surface "#171717"` (c1=`#ffaa00`, c2=`#5aa6e6`). Each dark value is the same hue made lighter.
  - **Pass criteria in both modes:**
    - CVD separation ≥ 6 for every pair. 6–8 is allowed because every multi-series chart has a legend.
    - Normal-vision ≥ 15.
    - Chroma floor passes for slots 3 and 4.
  - **Accepted failures:** orange's lightness-band FAIL in dark mode and orange's contrast WARN in light mode.
  - **Already ruled out:**
    - Aconite Violet `#a36aa5`, `#7d3f8f` and other purples: they collide with the blue for deuteranopes.
    - Peacock Blue `#00939b`: too close to the blue.
    - Olive Green `#6b7140`: below the chroma floor.
    - Theme red and green: they are status colors.
  - **Promising:** Red Violet `#59256a` passes CVD 15.9 in light mode but fails the lightness band, so try a lifted step of it, plus a green-teal such as Benzol Green `#00978d`. Note that Benzol Green has to stay clearly apart from `--success`.
  - **Output:** write the chosen 4 + 4 values and both validator outputs into `palette.md`.
  - **If no pair passes:** stop and report the best two candidates instead of shipping a failing pair.
- [ ] **Step 2: Write the failing test.** In `kit/test/dist.test.ts` add `it("kit.css defines the chart palette")`. For each of `--chart-1` … `--chart-4`, assert that `read("kit.css")` matches `/--chart-1\s*:\s*#e69500/` (light). Also assert that the dark blocks contain `--chart-1: #ffaa00` and `--chart-2: #5aa6e6` (both `prefers-color-scheme` and `data-theme="dark"` blocks, so count the occurrences: there must be 2 of each dark value).
- [ ] **Step 3: Run it to see it fail.** Run `npm run build -w kit && npx vitest run -c kit/vitest.config.ts kit/test/dist.test.ts`. Expected: FAIL on the new test.
- [ ] **Step 4: Add the tokens to `kit/src/kit.css`** with the values from the Global Constraints and Step 1. Put a comment above them: "Chart series colors, assigned in this order and never cycled. The theme's --accent/--success are status colors, not series."
- [ ] **Step 5: Run the test again.** Expected: PASS.
- [ ] **Step 6: Commit** with `git add kit/src/kit.css kit/test/dist.test.ts docs/superpowers/specs/2026-11-10-kit-charts-mockups/palette.md && git commit -m "feat(kit): chart color tokens"`.

---

### Task 2: Maths for scales, day slots, paths and formatting

**Files:**
- Create:
  - `kit/src/charts/scale.ts`
  - `kit/src/charts/days.ts`
  - `kit/src/charts/path.ts`
  - `kit/src/charts/format.ts`
- Test:
  - `kit/src/charts/scale.test.ts`
  - `kit/src/charts/days.test.ts`
  - `kit/src/charts/path.test.ts`
  - `kit/src/charts/format.test.ts`

These modules are internal and are **not** exported from `index.ts`.

**Interfaces (produces):**
```ts
// scale.ts
export interface Linear { (v: number): number; readonly domain: [number, number]; ticks(count?: number): number[] }
export function niceTicks(lo: number, hi: number, count?: number): number[];          // 1/2/5×10^k steps, inclusive of nice bounds
export function niceDomain(lo: number, hi: number, count?: number): [number, number];
export function linearScale(domain: [number, number], range: [number, number]): Linear;
export function seriesDomain(values: readonly number[], goal?: number): [number, number]; // includes goal, nice, never zero-height; [] → [0, 1]
// days.ts
export type DayInput = string | Date | number;
export function dayKey(x: DayInput | null | undefined): string | null;   // local "YYYY-MM-DD"; invalid → null
export function parseDay(key: string): Date;                              // local noon
export function addDays(key: string, n: number): string;
export function daySlots<T>(rows: readonly T[], x: (row: T) => DayInput | null | undefined): { days: string[]; byDay: Map<string, T> };
// path.ts
export type Pt = { x: number; y: number } | null;
export function linePath(points: readonly Pt[]): string;                   // null breaks; isolated point → "M x,y h0"
export function areaPath(top: readonly Pt[], bottom: readonly Pt[]): string; // only runs where both are non-null, runs ≥ 2
// format.ts
export function compact(n: number, locale?: string): string;               // 1,284 / 18.4K / 4.2M
export function formatValue(n: number, unit?: string, format?: (n: number) => string): string;
export function formatDay(key: string, locale?: string): string;           // Intl { month: "short", day: "numeric" }
export function nearestIndex(xs: readonly number[], px: number): number;   // -1 for []
```

- [ ] **Step 1: Write the failing tests** (Vitest, the same style as `kit/src/toast.test.ts`):
  - `niceTicks(0, 47, 4)` gives `[0, 10, 20, 30, 40, 50]`, and `niceDomain(21, 47)` gives `[20, 50]`.
  - `linearScale([0, 50], [130, 10])`: 0 maps to 130 and 50 maps to 10. `.ticks(4)` equals `niceTicks(0, 50, 4)`.
  - `seriesDomain([31, 44], 40)` contains 31, 44 and 40. `seriesDomain([36, 36])` has `hi > lo`. `seriesDomain([])` is `[0, 1]`.
  - `dayKey("2026-11-09")` is `"2026-11-09"`. `dayKey(new Date(2026, 10, 9, 23, 59))` is `"2026-11-09"`. `dayKey("nope")`, `dayKey(NaN)` and `dayKey(null)` are all `null`.
  - `parseDay("2026-11-09").getHours()` is 12.
  - `daySlots([{d:"2026-03-07"},{d:"2026-03-10"}], r => r.d).days` gives `["2026-03-07","2026-03-08","2026-03-09","2026-03-10"]` (US DST weekend). The same holds across `2026-10-31` → `2026-11-02`.
  - Duplicate days: the last row wins in `byDay`. Rows with an invalid x are dropped.
  - `linePath([{x:0,y:0},{x:10,y:5},null,{x:30,y:5}])` gives `"M0,0L10,5M30,5h0"`. Values are rounded to at most 1 decimal.
  - `linePath([])` and `linePath([null])` give `""`.
  - `areaPath` over top `[a,b,null,c]` and bottom `[a',b',null,c']` gives one closed subpath for a..b only (an isolated c draws no area). It ends with `"Z"`.
  - `compact(1284)` is `"1,284"`, `compact(18400)` is `"18.4K"`, `compact(4_200_000)` is `"4.2M"`, `compact(-3)` is `"-3"` and `compact(36.5)` is `"36.5"`. Tests pass `"en-US"` as the `locale` argument. In the components, `locale` is left `undefined`, so the browser's locale applies.
  - `formatValue(36, "wpm")` is `"36 wpm"`. `formatValue(36, "wpm", n => \`${n}!\`)` is `"36!"`.
  - `formatDay("2026-11-09")` matches `/Nov\s9/` under `en-US`.
  - `nearestIndex([0, 10, 20], 14)` is 1, `nearestIndex([0, 10, 20], 16)` is 2, and `nearestIndex([], 5)` is −1.
- [ ] **Step 2: Run the tests to see them fail.** Run `npx vitest run -c kit/vitest.config.ts kit/src/charts`. Expected: FAIL (the modules don't exist yet).
- [ ] **Step 3: Implement the four modules** with the signatures above.
  - `niceTicks`: the d3 algorithm (step = 10^floor(log10(span/count)) × the first of 1, 2, 5, 10 that gives ≤ count+1 ticks).
  - `seriesDomain`: pad a flat range by ±1 (or 5% of |value|, whichever is larger) before `niceDomain`.
  - `addDays`: step through `new Date(y, m, d + n, 12)`, never by adding 86_400_000.
- [ ] **Step 4: Run the tests.** Expected: PASS. Also run `npm run typecheck -w kit`: no errors.
- [ ] **Step 5: Commit** with `git add kit/src/charts && git commit -m "feat(kit): chart maths (scales, day slots, paths, formatting)"`.

---

### Task 3: Maths for the bar scale and heatmap layout

**Files:**
- Create: `kit/src/charts/bars.ts` and `kit/src/charts/heat.ts`.
- Test: `kit/src/charts/bars.test.ts` and `kit/src/charts/heat.test.ts`.

**Interfaces (produces):**
```ts
// bars.ts
export const GOAL_AT = 0.8;                        // goal tick position on the track, both directions
export function barFraction(value: number, o: { goal?: number; lower?: boolean; max?: number }): number; // 0..1
export function atGoal(value: number, goal: number, lower?: boolean): boolean;
// heat.ts
export type HeatCell = { day: string; col: number; row: number };     // row 0 = Monday
export function heatLayout(endDay: string, weeks: number): { cells: HeatCell[]; months: { col: number; day: string }[] };
export function heatLevel(value: number | null | undefined, max: number, steps?: number): number; // 0 = empty, 1..steps
export function fitWeeks(width: number, wanted: number, o?: { cell?: number; gap?: number; min?: number }): { weeks: number; cell: number };
```

- [ ] **Step 1: Write the failing tests.**
  - **`barFraction` for higher-is-better:** `barFraction(40, {goal:40})` is `0.8`, `barFraction(20, {goal:40})` is `0.4`, and `barFraction(100, {goal:40})` is `1` (clamped).
  - **`barFraction` without a goal:** `barFraction(5, {max:10})` is `0.5`.
  - **`barFraction` with `lower`:**
    - `barFraction(200, {goal:200, lower:true})` is `0.8`.
    - `barFraction(400, {goal:200, lower:true})` is `0.4`.
    - `barFraction(100, {goal:200, lower:true})` is `1`.
    - `barFraction(2000, {goal:200, lower:true})` is greater than 0 and less than `0.1`.
    - Bars stay in order: for values `[150, 250, 900]` with `lower`, the fractions strictly decrease.
  - **`barFraction` with bad values:** `NaN` gives `0`, and a value ≤ 0 with `lower` gives `1`.
  - **`atGoal`:** `atGoal(40,40)` is true, `atGoal(39,40)` is false, `atGoal(180,200,true)` is true and `atGoal(201,200,true)` is false.
  - **`heatLayout("2026-11-08", 2)`** (a Sunday): `cells.length === 14`, `cells[0]` is `{day:"2026-10-26", col:0, row:0}` (a Monday), and the last cell is `{day:"2026-11-08", col:1, row:6}`.
  - **`heatLayout("2026-11-09", 2)`** (a Monday): `cells.length === 8`, `cells[0].day === "2026-11-02"`, and the last cell is `{day:"2026-11-09", col:1, row:0}`. Days after the end day are never laid out.
  - **`heatLayout("2026-11-04", 2)`** (a Wednesday): `cells.length === 10`.
  - **Month labels:** `months` holds `{ col, day }`, where `day` is the month's 1st. `heatLayout("2026-11-08", 6).months` includes `{ col: 4, day: "2026-11-01" }`. Nov 1 is a Sunday, so it sits in the column that starts Oct 26, which is column 4 of 0..5. A label closer than 2 columns to the previous one is left out, and the earlier one is kept. A month whose 1st is before the first column gets no label.
  - **`heatLevel`:** `heatLevel(0, 40)` and `heatLevel(null, 40)` are `0`, `heatLevel(40, 40)` is `4`, and `heatLevel(1, 40)` is `1`.
  - **`fitWeeks`:** `fitWeeks(270, 12)` gives `{weeks:12, cell:18}` (12×22−4 = 260 ≤ 270). `fitWeeks(200, 12)` shrinks the cell to `floor((200+4)/12)−4 = 13`, so it gives `{weeks:12, cell:13}`. `fitWeeks(100, 12)` gives `{cell:10, weeks: floor((100+4)/14) = 7}`.
- [ ] **Step 2: Run the tests to see them fail.** Run `npx vitest run -c kit/vitest.config.ts kit/src/charts`. Expected: FAIL.
- [ ] **Step 3: Implement both modules.**
  - `barFraction(lower)` is `clamp(GOAL_AT × goal / value, 0, 1)`.
  - Higher is `clamp(GOAL_AT × value / goal, 0, 1)`.
  - With no goal it is `clamp(value / max, 0, 1)`.
  - `heatLevel` is `min(steps, ceil(value / max × steps))` with `steps` = 4.
  - `heatLayout` uses `addDays`/`parseDay` from Task 2.
  - The defaults for `fitWeeks` are `cell` 18, `gap` 4 and `min` 10.
- [ ] **Step 4: Run the tests.** Expected: PASS. `npm run typecheck -w kit` is clean.
- [ ] **Step 5: Commit** with `git add kit/src/charts && git commit -m "feat(kit): bar scale and heatmap layout"`.

---

### Task 4: `tk-stat`, `tk-stats`, `tk-sparkline` and the charts demo page

**Files:**
- Create:
  - `kit/src/charts/tk-stat.ts`
  - `kit/src/charts/tk-stats.ts`
  - `kit/src/charts/tk-sparkline.ts`
  - `kit/demo/charts.html`
  - `kit/e2e/charts.spec.ts`
- Modify: `kit/src/index.ts` (exports), `kit/scripts/build.ts` (copy `demo/charts.html` to `dist/charts.html` like `bare.html`).

**Interfaces:**
- Consumes: `compact` and `formatValue` (Task 2), and `linePath` and `linearScale` (Task 2).
- Produces:
  - **`TkStat`** (`tk-stat`), with these properties:
    - `label: string`
    - `value: string | number` (compacted when it's a number)
    - `unit: string`
    - `change: string`
    - `good: "up" | "down" | ""`
    - `trend: number[]` (`attribute: false`)
    - `wide: boolean` (reflected)
  - **`TkStats`** (`tk-stats`): a two-column grid with a 6px gap. `::slotted(tk-stat[wide]) { grid-column: 1 / -1 }`.
  - **`TkSparkline`** (`tk-sparkline`), with `values: number[]` (`attribute: false`).
    - The default size is `:host { display:block; width:110px; height:40px }`, and CSS can override it.
    - It draws a 2px `--chart-1` line and an end dot (r 3.5, a 2px ring in `var(--tk-spark-ring, var(--bg))`). In a tile, the ring is set to `--panel`.
  - **`demo/charts.html`:** a `tk-shell` with an `aside` slot section that holds every chart, plus a full-width copy in main.
    - The page reads `?theme=dark|light` and sets `document.documentElement.dataset.theme`.
    - Its data is deterministic (a seeded PRNG, 40 days ending 2026-11-09, with skipped days).
    - It exposes the data as `window.demo = { days, keys, cal }` for tests.

- [ ] **Step 1: Write the failing e2e tests** in `kit/e2e/charts.spec.ts`.
  - `test("stat tiles: two columns, wide spans both")`: in `aside tk-stats`, the first non-wide tile's width is about (stats width − 6) / 2 (±1), and the `[wide]` tile's width equals the `tk-stats` width.
  - `test("stat change colors only with good")`:
    - With `good="up"` and `change="+5 vs previous 2 weeks"`, the computed color equals the resolved `--success`.
    - With `change="−3 …"` and `good="up"`, it equals `--accent`.
    - Without `good`, it equals `--text-secondary`.
  - `test("stat value compacts numbers")`: `value=18400` renders `18.4K`.
  - `test("sparkline draws one path in --chart-1")`: the path's `stroke` resolves to `rgb(230, 149, 0)` (light) and to `rgb(255, 170, 0)` with `?theme=dark`.
  - A shared helper, `textSizes(page, selector)`, walks the open shadow roots and returns the computed `font-size` of every element with direct text. `test("no chart text under 12px")` asserts that every size is ≥ 12, for each `tk-*` chart on the page. Later tasks reuse this helper.
- [ ] **Step 2: Run the tests to see them fail.** Run `npm run build -w kit && npx playwright test -c kit/playwright.config.ts kit/e2e/charts.spec.ts`. Expected: FAIL (`dist/charts.html` doesn't exist yet).
- [ ] **Step 3: Implement the three elements, the demo page and the build copy.**
  - Tile CSS per the spec: `--panel` fill, `--radius`, padding 8px 10px, a 13px `--text-secondary` label, a 24px bold value with `line-height 1.15` and proportional figures, and a 12px change line.
  - A wide tile with `trend` lays out flex row: text on the left, a 110×40 sparkline on the right.
  - `good` coloring: the sign is the first character of `change` (`+` is up; `-` or `−` is down). The color is `--success` when the direction matches `good` and `--accent` otherwise.
  - Export `TkStat`, `TkStats` and `TkSparkline` from `kit/src/index.ts`.
- [ ] **Step 4: Run the tests.** Run `npm run build -w kit && npx playwright test -c kit/playwright.config.ts kit/e2e/charts.spec.ts`. Expected: PASS on both projects. Also run `npm test -w kit` (unit + dist): PASS.
- [ ] **Step 5: Commit** with `git add kit && git commit -m "feat(kit): tk-stat, tk-stats, tk-sparkline and charts demo"`.

---

### Task 5: `ChartBase`, the shared readout, keyboard, live region and table

**Files:**
- Create: `kit/src/charts/chart-base.ts` (not exported as an element, so it has no `customElements.define`).
- Modify: `kit/e2e/charts.spec.ts`. The behaviour is covered there through the first concrete chart in Task 6. This task adds only a unit test of the pure helpers in it.
- Test: `kit/src/charts/chart-base.test.ts`, for the pure helpers only.

**Interfaces (produces):**
```ts
export function stepIndex(current: number | null, key: string, count: number, vstep?: number): number | null | undefined; // undefined = key not handled
export function clampIndex(i: number | null, count: number): number | null;
export abstract class ChartBase extends LitElement {
  // shared properties (all in each subclass's `static properties` via `...ChartBase.baseProperties`)
  static baseProperties: { data: { attribute: false }; unit: {}; summary: {}; empty: {}; format: { attribute: false }; active: { state: true }; width: { state: true } };
  declare data: readonly unknown[]; declare unit: string; declare summary: string; declare empty: string;
  declare format: ((n: number) => string) | undefined; declare active: number | null; declare width: number;
  protected abstract count(): number;                         // number of steppable items
  protected abstract datum(i: number): unknown;               // payload for tk-readout
  protected abstract readoutText(i: number | null): string;   // rest state when i === null
  protected abstract tableRows(): { head: string[]; rows: string[][] };
  protected abstract autoSummary(): string;
  protected vstep(): number;                                   // default 1; heatmap returns 7
  protected setActive(i: number | null): void;                 // clamps, dispatches tk-readout, schedules live text
  protected renderReadout(): TemplateResult;                   // <p class="readout" part="readout">…</p>, fixed one-line height
  protected plotLabel(): string;                               // this.summary || this.autoSummary(); plot gets tabindex="0" role="img" aria-label
  protected renderTable(): TemplateResult;                     // visually hidden <table>
  protected renderEmpty(): TemplateResult;                     // one quiet line, text = this.empty || "No data yet"
}
```

- **The event:** `tk-readout` is a `CustomEvent<{ index: number | null; datum: unknown }>` with `bubbles` and `composed`.
- **Sizing:** `ResizeObserver` on the host sets `width` from `contentRect.width`, rounded down.
- **Clamping:** `updated()` runs `active = clampIndex(active, count())` when `data` changes.

- [ ] **Step 1: Write the failing unit tests.**
  - `stepIndex(null, "ArrowRight", 5)` is `4`: the first key from rest starts at the latest point, because rest shows the latest.
  - `stepIndex(2, "ArrowLeft", 5)` is `1`, `stepIndex(0, "ArrowLeft", 5)` is `0`, `stepIndex(4, "ArrowRight", 5)` is `4`, `stepIndex(2, "Home", 5)` is `0` and `stepIndex(2, "End", 5)` is `4`.
  - `stepIndex(2, "Escape", 5)` is `null`.
  - `stepIndex(10, "ArrowUp", 20, 7)` is `3` and `stepIndex(10, "ArrowDown", 20, 7)` is `17`. Without `vstep`, Up/Down return `undefined`.
  - `stepIndex(1, "a", 5)` is `undefined`.
  - `clampIndex(7, 3)` is `2`, `clampIndex(1, 0)` is `null` and `clampIndex(null, 3)` is `null`.
- [ ] **Step 2: Run the tests to see them fail.** Run `npx vitest run -c kit/vitest.config.ts kit/src/charts/chart-base.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `chart-base.ts`.**
  - **Live region:** a visually hidden `<span aria-live="polite">`, updated by a trailing throttle of 400 ms.
  - **Readout:** a `.readout` line, 13px `--text-secondary`, with values wrapped in `<b>` in `--text-primary`. It has a fixed `height: 1.4em`, `white-space: nowrap`, `overflow: hidden` and `text-overflow: ellipsis` so it never changes the layout.
  - **Keyboard:** a `keydown` handler on the plot uses `stepIndex` and calls `preventDefault` when the key is handled.
  - **Focus:** `:focus-visible` on the plot uses `outline: 2px solid var(--ring)`.
  - **Reduced motion:** `@media (prefers-reduced-motion: reduce)` turns off transitions.
- [ ] **Step 4: Run the tests.** Expected: PASS. `npm run typecheck -w kit` is clean.
- [ ] **Step 5: Commit** with `git add kit/src/charts && git commit -m "feat(kit): ChartBase readout, keyboard and live region"`.

---

### Task 6: `tk-timeseries`

**Files:**
- Create: `kit/src/charts/tk-timeseries.ts`.
- Modify:
  - `kit/src/index.ts` (export `TkTimeseries`, `type TimeseriesSeries`).
  - `kit/demo/charts.html`. Add a two-series + band + goal chart in the aside, a single-series one at full width, an empty one, and a one-row one.
  - `kit/e2e/charts.spec.ts`.

**Interfaces:**
- Consumes: `ChartBase` (Task 5), `daySlots`/`dayKey`/`formatDay`/`seriesDomain`/`linearScale`/`linePath`/`areaPath`/`nearestIndex`/`formatValue` (Task 2), and `--chart-1..4` (Task 1).
- Produces:
  - **`TkTimeseries`** (`tk-timeseries`), with these properties, plus the base ones:
    - `x` (default `"day"`)
    - `y` (single-series field)
    - `defined` (`attribute: false`, `(row) => boolean`)
    - `series` (`attribute: false`, `TimeseriesSeries[]`)
    - `band` (a string with two series `y` names separated by a space)
    - `bandLabel` (`band-label`)
    - `goal` (Number)
    - `goalLabel` (`goal-label`, default `"goal"`)
    - `height` (Number, default 140)
  - **The series type:** `export type TimeseriesSeries = { y: string; label: string; defined?: (row: any) => boolean }`.
  - **The y domain** is computed over all defined values, plus the goal.
  - **Series limit:** a fifth series logs `console.warn` and is not drawn.
- **Layout per the spec and mockup B:**
  - The readout line sits on top.
  - The plot has 3–4 gridlines from `ticks(4)` that fall inside the domain, with their values right-aligned at the right edge. The right padding is the measured width of the widest tick label + 4px (use 28px if it can't be measured).
  - The goal line has its label "goal N" on the left.
  - The band is the wash of the *second* band series' color at 12% (`color-mix(in srgb, var(--chart-N) 12%, transparent)`).
  - The lines are drawn in series order, and the latest defined point of series 1 gets an end marker.
  - Under the plot sit the first and last dates (12px, `space-between`), then a legend row only when there are 2 or more series or a band. A legend entry is a 12×2 swatch, or 12×8 for the band.
  - Hover/drag uses `pointermove` and `pointerdown` on the plot to compute `nearestIndex` over the slot centres, draws a 1px `--line` crosshair at that slot and rings that slot's points.
  - `pointerleave` and `pointercancel` reset to rest unless the plot has keyboard focus.
  - The readout text looks like `"Nov 3 · with pauses 38 wpm · typing only 44 wpm"`, and a missing series reads `"—"`.
  - The auto summary looks like `"40 days, 34 with data. with pauses: latest 36 wpm, best 45 wpm. Goal 40 wpm."`.

- [ ] **Step 1: Write the failing e2e tests.**
  - **`test("timeseries fits the aside without overflow")`:** for `aside tk-timeseries`, `scrollWidth ≤ clientWidth` on the host and the svg. The svg's width equals the host's content width (±1).
  - **`test("missing days break the line")`:**
    - Each series path's `d` contains as many `M` commands as there are runs of consecutive defined days in `window.demo.days`. The test computes the expected count from the data.
  - **`test("defined() hides zeros")`:**
    - The demo's second series is fed with a `defined: r => r.strokeWpm > 0` predicate, and the data has one day with `strokeWpm: 0`.
    - That day must start a new `M` instead of plotting y at 0.
    - Assert that no path coordinate has a y equal to the y of value 0.
  - **`test("one-row chart draws a point")`:** the one-row demo's path `d` matches `/^M[\d.]+,[\d.]+h0$/` and the end marker circle exists.
  - **`test("empty data shows the empty line")`:** the text is `"No data yet"` and there is no svg.
  - **`test("hover updates the readout, leave restores it")`:**
    - Move the mouse to the plot's left edge + 2px. The readout contains `formatDay(first day)`.
    - Move it to the right end. The readout contains the last day.
    - `mouse.move` outside the plot brings back the rest text (the last day).
  - **`test("keyboard steps and fires tk-readout")`:**
    - Focus the plot and press End, then ArrowLeft. The readout shows the second-to-last *slot* day.
    - A `tk-readout` listener on `document` received `{ index: count-2 }`.
    - Escape brings back the rest text.
  - **`test("touch drag scrubs horizontally")`:** for the phone project only, open the aside drawer (`tk-shell` method `show("aside")`).
    - Dispatch a `pointerdown` at the left of the plot, then a `pointermove` to the right, both with `pointerType: "touch"`. The readout changes.
    - Also assert that the plot's computed `touch-action` is `pan-y`.
  - **`test("dark theme uses dark chart colors")`:** with `?theme=dark`, series 1's stroke is `rgb(255, 170, 0)` and series 2's is `rgb(90, 166, 230)`.
  - **Text size:** extend the `no chart text under 12px` test to cover `tk-timeseries`.
- [ ] **Step 2: Run the tests to see them fail.** Run `npm run build -w kit && npx playwright test -c kit/playwright.config.ts kit/e2e/charts.spec.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement `tk-timeseries`.**
  - Read rows through `daySlots(this.data, r => r[this.x])`.
  - For each series, `pts[i] = isDefined(row) ? {x: slotCentre(i), y: yScale(v)} : null`.
  - `isDefined` is the series' `defined` (or the element's `defined` for `y`) when given. Otherwise the value is a finite number.
- [ ] **Step 4: Run the tests.** Expected: PASS on desktop and phone.
- [ ] **Step 5: Commit** with `git add kit && git commit -m "feat(kit): tk-timeseries"`.

---

### Task 7: `tk-bars`

**Files:**
- Create: `kit/src/charts/tk-bars.ts`.
- Modify: `kit/src/index.ts` (export `TkBars`), `kit/demo/charts.html` (a wpm list with a goal in the aside, an ms list with `lower` and a goal, a list with no goal) and `kit/e2e/charts.spec.ts`.

**Interfaces:**
- Consumes: `ChartBase`, `barFraction`/`atGoal`/`GOAL_AT` (Task 3) and `formatValue` (Task 2).
- Produces: **`TkBars`** (`tk-bars`), with these properties, plus the base ones:
  - `label` (field name, default `"label"`)
  - `value` (field name, default `"value"`)
  - `goal` (Number)
  - `lower` (Boolean)
- **Rows:**
  - Rows follow the data order. Each row is two lines: a bold `--text-primary` label on the left and the formatted value on the right (`--text-secondary`, tabular), then the 8px track and fill.
  - Rows are 8px apart.
  - The fill is `--chart-1` when `atGoal` (or when there is no goal) and `--chart-2` otherwise.
  - The goal tick sits at `GOAL_AT × 100%` on every row. With no goal, `max` is the largest value.
- **Readout at rest:** `"3 of 8 at goal"` when there is a goal. With no goal it is empty but keeps its height.
- **Readout when active:** `"o · 39 wpm · below goal"` or `"… · at goal"`. Status is written in words, never shown by color alone.
- **Hover and touch:** the whole row is the hit target. The active row's label and value get `--text-primary` and the other rows' fills drop to 55% opacity.

- [ ] **Step 1: Write the failing e2e tests.**
  - `test("bars: goal tick at the same x on every row")`: every `.tick` has the same `left` (±0.5px), and the shared tick sits at 80% of the track width.
  - `test("bars: under-goal fill is --chart-2")`: a row with a value below the goal has fill `rgb(0, 110, 184)` (light), and an at-goal row has `rgb(230, 149, 0)`.
  - `test("lower: faster gets the longer bar")`: in the ms demo, sorting the rows by value ascending gives fill widths that strictly decrease. A row at exactly the goal has a fill width equal to the tick's x (±1px).
  - `test("bars readout: rest summary, hover, keyboard")`:
    - At rest, the readout matches `/\d+ of \d+ at goal/`.
    - Hovering row 3 gives that row's label and value plus `below goal` or `at goal`.
    - Focus and press End: the readout shows the last row. Press ArrowLeft: it shows the row before. ArrowDown is not handled, so the readout doesn't change.
  - Extend the 12px text test to cover `tk-bars`.
- [ ] **Step 2: Run the tests to see them fail.** Same command as Task 6. Expected: the new tests FAIL.
- [ ] **Step 3: Implement `tk-bars`.**
- [ ] **Step 4: Run the tests.** Expected: PASS on both projects.
- [ ] **Step 5: Commit** with `git add kit && git commit -m "feat(kit): tk-bars"`.

---

### Task 8: `tk-heatmap`

**Files:**
- Create: `kit/src/charts/tk-heatmap.ts`.
- Modify: `kit/src/index.ts` (export `TkHeatmap`), `kit/demo/charts.html` (12 weeks in the aside, a narrow 200px container, `end="2026-11-09"`) and `kit/e2e/charts.spec.ts`.

**Interfaces:**
- Consumes: `ChartBase` (with `vstep()` returning 7), `heatLayout`/`heatLevel`/`fitWeeks` (Task 3) and `dayKey`/`formatDay`/`formatValue` (Task 2).
- Produces: **`TkHeatmap`** (`tk-heatmap`), with these properties, plus the base ones:
  - `x` (default `"day"`)
  - `value` (default `"value"`)
  - `weeks` (Number, default 12)
  - `end` (a `"YYYY-MM-DD"` string, defaulting to today's local `dayKey(new Date())`)
  - `legend` (Boolean)
- **Cells:**
  - Cells are rounded rects with `rx` 2 and a 4px gap.
  - An empty cell (level 0) is `--panel`. Levels 1–4 are `color-mix(in srgb, var(--chart-1) P%, var(--panel))` with P = 30, 52, 76, 100.
  - The steppable index runs over the cells in day order.
- **Month labels:** they come from `heatLayout().months`, formatted with `{ month: "short" }`, 12px `--text-secondary`, above the grid.
- **Legend (when `legend` is set):** `less ▢▢▢▢▢ more`, right-aligned.
- **Readout at rest:** `"34 days · 312 min"`, over the visible range.
- **Readout when active:** `"Nov 3 · 22 min"`, or `"Nov 3 · none"`.
- **Active cell:** a 2px `--text-primary` ring.

- [ ] **Step 1: Write the failing e2e tests.**
  - `test("heatmap: Monday rows, last cell is end day")`: the last rendered cell's `data-day` is `"2026-11-09"` (a Monday) and it is in row 0, the top row. The cell with `data-day="2026-11-08"` (a Sunday) is in row 6, one column to the left.
  - `test("heatmap: narrow container drops oldest weeks, never overflows")`:
    - In the 200px demo, `scrollWidth ≤ clientWidth`, and the cell width is ≥ 10px (the shrunk width, not the full 18px).
    - Then set the container to 100px through `evaluate` and wait for a frame. There are fewer columns, the last cell is still `2026-11-09`, and nothing overflows.
  - `test("heatmap: zero and missing are the same empty color")`: a day with `value: 0` and a day absent from the data both have fill equal to the resolved `--panel`.
  - `test("heatmap keyboard: ArrowUp moves a week")`: focus, press End (Nov 9), then ArrowUp. The readout shows `Nov 2`.
  - Extend the 12px text test to cover `tk-heatmap`.
- [ ] **Step 2: Run the tests to see them fail.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement `tk-heatmap`.** Run `fitWeeks(this.width, this.weeks)` and lay out `heatLayout(end, fitted.weeks)`.
- [ ] **Step 4: Run the tests.** Expected: PASS on both projects.
- [ ] **Step 5: Commit** with `git add kit && git commit -m "feat(kit): tk-heatmap"`.

---

### Task 9: Accessibility pass, README, API surface and full verification

**Files:**
- Modify: `kit/README.md` (a new "Charts" section after "Side panels"), `kit/e2e/charts.spec.ts` and `kit/src/charts/*.ts` (only if the tests below fail).

**Interfaces:** consumes all of the above.

- [ ] **Step 1: Write the failing tests.**
  - `test("every plot has role=img and a summary")`:
    - Each chart plot in the demo has `role="img"` and an `aria-label` longer than 20 characters.
    - Setting the `summary` attribute on one of them replaces its label.
  - `test("hidden table carries the data")`: `tk-timeseries` contains a `table` with one row per slot that has data. It is visually hidden (its `clip`/size is 1px) and still exists in the accessibility tree (`page.getByRole("table")` inside the host's shadow root has a count of at least 1).
  - `test("live region is throttled")`: press ArrowLeft 10 times quickly. After 1 s, the `[aria-live]` text changed at most 3 times (count it with a MutationObserver installed beforehand).
  - `test("forced colors keep marks visible")`: `page.emulateMedia({ forcedColors: "active" })`, then the series path's computed stroke is not `none`/transparent. Use `CanvasText` fallbacks in `@media (forced-colors: active)`.
- [ ] **Step 2: Run the tests.** Expected: the new tests FAIL where a gap exists. Fix those gaps in the components.
- [ ] **Step 3: Write the README "Charts" section** in the style of "Side panels" (headings, short lists, one HTML example per component).
  - Cover the attribute and property tables, the `defined` predicate (with keeb's zero case as the example), "x is always a calendar day", `lower` on bars, `good` on stats, the readout and `tk-readout` event, and the color tokens with their rule ("red and green are status, not series").
  - Link `https://kit.thatsit.app/charts.html`.
- [ ] **Step 4: Run full verification.**
  - Run `npm run build -w kit && npm test -w kit && npm run typecheck -w kit && npm run e2e -w kit`. Expected: all PASS.
  - Run `npm run check-api -w kit`. Expected: it reports only additions, which are the new `elements`, `exports`, `attributes`, `cssProps` (`--chart-*`, `--tk-spark-ring`), the `events` entry (`tk-readout`) and `files` (none: `charts.html` is not an entry file). Paste the output into the PR body.
  - Record `wc -c kit/dist/kit.js` before (23,875 bytes on master) and after, for the PR.
- [ ] **Step 5: Take screenshots for the PR.** Use the aside at 300px and the full width, light and dark, saved to `docs/superpowers/specs/2026-11-10-kit-charts-mockups/built-*.png`. **Look at them**, comparing against `density.png` panel B: label collisions, cramped gridline values, the readout's height.
- [ ] **Step 6: Commit** with `git add kit docs && git commit -m "docs(kit): charts README; a11y pass"`.

---

### Task 10: Review gate, then ship the kit (Michael's go)

- [ ] **Step 1:** Run a whole-branch review (superpowers:requesting-code-review) against the spec, and fix what it finds.
- [ ] **Step 2: STOP.** Report to Michael with the branch, test results, check-api additions, bundle size and screenshots. Ask whether to merge `feat/kit-charts` into master and push. Pushing master deploys kit.thatsit.app through `.github/workflows/kit.yml`. **Do nothing further without his go-ahead.**
- [ ] **Step 3: After the go-ahead and the deploy, check the live kit.**
  - `curl -s https://kit.thatsit.app/api.json | grep -c 'tk-timeseries'` must print ≥ 1.
  - `curl -s https://kit.thatsit.app/kit.d.ts` must resolve and the types must include `TkTimeseries`.
  - `https://kit.thatsit.app/charts.html` must load.

---

### Task 11: Teach pi to use the charts (only after Task 10's live check passes)

**Files:**
- Modify: `pi-web/skills/thatsit-app/SKILL.md`. In the "Use only kit components" bullet (~line 124), append: `tk-stats`/`tk-stat`, `tk-sparkline`, `tk-timeseries`, `tk-bars` and `tk-heatmap` for numbers and charts (kit README "Charts"; never hand-build chart SVG, canvas or d3).
- Modify: `pi-web/skills/thatsit-app/test/skill-md.test.ts`. Add `"tk-timeseries"` to an asserted-strings list, or add a test the same way as line 37.
- Modify: `~/workspace/app-template/AGENTS.md`. Below the "Side panels" bullet (~line 80), add: "Numbers and charts: use the kit's `tk-stat`/`tk-stats`, `tk-sparkline`, `tk-timeseries`, `tk-bars` and `tk-heatmap` (kit README 'Charts'). Never draw charts yourself with SVG, canvas or d3, and never pick chart colors."
- Modify: `~/workspace/app-template/README.md` "Rules". Add one line: "Charts: use the kit's chart components; see https://kit.thatsit.app/charts.html."

- [ ] **Step 1: Write the failing test** in `skill-md.test.ts`: `SKILL.md` contains `tk-timeseries` and `d3`.
- [ ] **Step 2: Run it.** Run `npm test -w skills/thatsit-app`. Expected: FAIL.
- [ ] **Step 3: Edit `SKILL.md`.** Run the test again. Expected: PASS. Commit in pi-web with `git commit -m "docs(skill): use kit charts"`.
- [ ] **Step 4: Edit the template.** Create the branch `docs/kit-charts` in `~/workspace/app-template`, edit `AGENTS.md` and `README.md`, run `npm run guardrails` (expected: PASS) and commit with `docs: use kit charts`.
- [ ] **Step 5: STOP.** Ask Michael before pushing either repo or opening the template PR. He merges. Tell him that existing apps get the rule through `thatsit-app sync-template`, and that keeb's migration is a separate pi prompt.
