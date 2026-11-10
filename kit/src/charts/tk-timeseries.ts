import { type PropertyDeclarations, type PropertyValues, css, html, nothing, svg } from "lit";
import { ChartBase } from "./chart-base.ts";
import { type DayInput, daySlots } from "./days.ts";
import { compact, formatDay, formatValue, nearestIndex } from "./format.ts";
import { areaPath, linePath, type Pt } from "./path.ts";
import { linearScale, niceTicks, seriesDomain } from "./scale.ts";

/** One line of a time series: the row field, its legend/readout label and an optional "is measured" test. */
export type TimeseriesSeries = { y: string; label: string; defined?: (row: any) => boolean };

const MAX_SERIES = 4;
const PAD_TOP = 8; // half a gridline label above the top gridline, and room for a marker
const PAD_BOTTOM = 6; // a marker (r 4 + ring) at the bottom never clips
const LABEL_PAD = 4; // gap between the plot and the gridline values
const FALLBACK_PAD = 28; // right padding when text can't be measured

let measureCtx: CanvasRenderingContext2D | null | undefined;
function measure(text: string, font: string): number | undefined {
	if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d");
	if (!measureCtx) return undefined;
	measureCtx.font = font;
	const w = measureCtx.measureText(text).width;
	return Number.isFinite(w) && w > 0 ? w : undefined;
}

/**
 * Day-by-day line chart: up to four series, gaps where a day has no value, an optional band
 * between two series, an optional goal line, and a readout line driven by hover, touch drag or keys.
 *
 *     <tk-timeseries .data=${rows} x="day" .series=${[{ y: "wpm", label: "with pauses" }, …]}
 *         band="wpm strokeWpm" band-label="pausing" goal="40" unit="wpm"></tk-timeseries>
 *
 * `y="wpm"` (with the optional `.defined`) is the single-series shorthand. Every day between the
 * first and last row gets its own slot. The `tk-readout` datum is `{ day, row }` (row null on an empty day).
 */
export class TkTimeseries extends ChartBase {
	static properties: PropertyDeclarations = {
		unit: {},
		summary: {},
		empty: {},
		x: {},
		y: {},
		defined: { attribute: false },
		series: { attribute: false },
		band: {},
		bandLabel: { attribute: "band-label" },
		goal: { type: Number },
		goalLabel: { attribute: "goal-label" },
		height: { type: Number },
	};
	declare x: string;
	declare y: string;
	declare defined: ((row: any) => boolean) | undefined;
	declare series: TimeseriesSeries[];
	declare band: string;
	declare bandLabel: string;
	declare goal: number | undefined;
	declare goalLabel: string;
	declare height: number;

	static styles = [
		ChartBase.styles,
		css`
			:host { --tk-chart-surface: var(--bg); }
			.plot { cursor: crosshair; }
			svg { display: block; overflow: visible; }
			text { font-size: 12px; fill: var(--text-secondary); }
			.tick { text-anchor: end; dominant-baseline: middle; font-variant-numeric: tabular-nums; }
			.grid { stroke: var(--line); stroke-width: 1; shape-rendering: crispEdges; }
			.goal { stroke: var(--text-primary); stroke-opacity: 0.55; stroke-width: 1; shape-rendering: crispEdges; }
			.goal-label { font-weight: 700; paint-order: stroke; stroke: var(--tk-chart-surface); stroke-width: 3px; stroke-linejoin: round; }
			.cross { stroke: var(--line); stroke-width: 1; shape-rendering: crispEdges; }
			.s1 { --c: var(--chart-1); } .s2 { --c: var(--chart-2); } .s3 { --c: var(--chart-3); } .s4 { --c: var(--chart-4); }
			.line { fill: none; stroke: var(--c); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
			.band { stroke: none; }
			circle { fill: var(--c); stroke: var(--tk-chart-surface); stroke-width: 2; }
			.dates { display: flex; justify-content: space-between; gap: 8px; margin-top: 4px; font-size: 12px; line-height: 1.3; color: var(--text-secondary); }
			.legend { display: flex; flex-wrap: wrap; gap: 2px 12px; margin-top: 4px; font-size: 12px; line-height: 1.3; color: var(--text-secondary); }
			.legend span { display: inline-flex; align-items: center; gap: 4px; }
			.sw { display: inline-block; width: 12px; height: 2px; border-radius: 1px; background: var(--c); flex: none; }
			.sw.wash { height: 8px; }
			.readout { font-size: 12px; } /* spec allows 12-13px; two labelled series fit a 300px aside at 12 */
			.readout .sw { width: 6px; vertical-align: middle; margin: 0 2px 0 0; position: relative; top: -1px; }
			@media (forced-colors: active) {
				.line { stroke: CanvasText; } .cross, .grid { stroke: GrayText; } circle { fill: CanvasText; stroke: Canvas; }
				.sw { background: CanvasText; }
			}
		`,
	];

	private days: string[] = [];
	private byDay = new Map<string, unknown>();
	private lines: (TimeseriesSeries & { cls: string })[] = [];
	// Slot centres of the last render, for hit-testing.
	private centres: number[] = [];

	constructor() {
		super();
		this.x = "day";
		this.y = "";
		this.defined = undefined;
		this.series = [];
		this.band = "";
		this.bandLabel = "";
		this.goal = undefined;
		this.goalLabel = "goal";
		this.height = 140;
	}

	connectedCallback(): void {
		super.connectedCallback();
		// Tick labels are measured with the body font; re-measure once web fonts have loaded.
		document.fonts?.ready.then(() => this.requestUpdate());
	}

	protected willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("data") || changed.has("x")) {
			const { days, byDay } = daySlots(this.data ?? [], (r) => (r as Record<string, unknown>)?.[this.x] as DayInput);
			this.days = days;
			this.byDay = byDay;
		}
		if (changed.has("series") || changed.has("y") || changed.has("defined")) {
			const list: TimeseriesSeries[] = this.series?.length ? this.series : this.y ? [{ y: this.y, label: "", defined: this.defined }] : [];
			if (list.length > MAX_SERIES) console.warn(`tk-timeseries: at most ${MAX_SERIES} series are drawn; ignoring ${list.length - MAX_SERIES} more`);
			this.lines = list.slice(0, MAX_SERIES).map((s, i) => ({ ...s, cls: `s${i + 1}` }));
		}
		super.willUpdate(changed);
	}

	// ---- data access ----

	private row(i: number): Record<string, unknown> | undefined {
		return this.byDay.get(this.days[i]) as Record<string, unknown> | undefined;
	}

	private value(s: TimeseriesSeries, i: number): number | null {
		const row = this.row(i);
		if (!row) return null;
		const v = row[s.y];
		if (s.defined) return s.defined(row) && typeof v === "number" && Number.isFinite(v) ? v : null;
		return typeof v === "number" && Number.isFinite(v) ? v : null;
	}

	private goalValue(): number | undefined {
		const g = this.goal;
		return typeof g === "number" && Number.isFinite(g) ? g : undefined;
	}

	/** Latest slot where any series has a value (the rest state), or the last slot. */
	private latest(): number {
		for (let i = this.days.length - 1; i >= 0; i--) if (this.lines.some((s) => this.value(s, i) !== null)) return i;
		return this.days.length - 1;
	}

	private fmt(v: number | null): string {
		return v === null ? "—" : formatValue(v, this.unit, this.format);
	}

	// ---- ChartBase ----

	protected count(): number {
		return this.days.length;
	}

	protected datum(i: number): unknown {
		return { day: this.days[i], row: this.row(i) ?? null };
	}

	protected readoutText(i: number | null): string {
		const at = i ?? this.latest();
		if (at < 0) return "";
		const multi = this.lines.length > 1;
		const parts = this.lines.map((s) => (multi ? `${s.label} ${this.fmt(this.value(s, at))}` : this.fmt(this.value(s, at))));
		return [formatDay(this.days[at]), ...parts].join(" · ");
	}

	protected readoutContent(i: number | null): unknown {
		const at = i ?? this.latest();
		if (at < 0) return "";
		const multi = this.lines.length > 1;
		// Room is tight in a 300px aside: with several series and the default format, the unit is
		// written once, after the last value. The live region keeps the full text (readoutText).
		const shortUnit = multi && !this.format && !!this.unit;
		let last = -1;
		this.lines.forEach((s, k) => {
			if (this.value(s, at) !== null) last = k;
		});
		const val = (s: TimeseriesSeries, k: number) => {
			const v = this.value(s, at);
			if (!shortUnit || v === null) return this.fmt(v);
			return k === last ? `${compact(v)} ${this.unit}` : compact(v);
		};
		return html`${formatDay(this.days[at])}${this.lines.map(
			(s, k) => html` · ${multi ? html`<span class="sw ${s.cls}"></span>${s.label} ` : nothing}<b>${val(s, k)}</b>`,
		)}`;
	}

	protected tableRows(): { head: string[]; rows: string[][] } {
		const head = ["Day", ...this.lines.map((s) => s.label || this.unit || s.y)];
		const rows = this.days.map((d, i) => [formatDay(d), ...this.lines.map((s) => this.fmt(this.value(s, i)))]);
		return { head, rows };
	}

	protected autoSummary(): string {
		const n = this.days.length;
		let withData = 0;
		for (let i = 0; i < n; i++) if (this.lines.some((s) => this.value(s, i) !== null)) withData++;
		const out = [`${n} ${n === 1 ? "day" : "days"}, ${withData} with data.`];
		const s = this.lines[0];
		if (s) {
			const vals: number[] = [];
			let last: number | null = null;
			for (let i = 0; i < n; i++) {
				const v = this.value(s, i);
				if (v !== null) {
					vals.push(v);
					last = v;
				}
			}
			if (last !== null) {
				const body = `latest ${this.fmt(last)}, best ${this.fmt(Math.max(...vals))}.`;
				out.push(s.label ? `${s.label}: ${body}` : body.charAt(0).toUpperCase() + body.slice(1));
			}
		}
		const g = this.goalValue();
		if (g !== undefined) out.push(`Goal ${this.fmt(g)}.`);
		return out.join(" ");
	}

	// ---- pointer ----

	private indexAt(clientX: number): number {
		const plot = this.renderRoot.querySelector(".plot");
		if (!plot || this.centres.length === 0) return -1;
		return nearestIndex(this.centres, clientX - plot.getBoundingClientRect().left);
	}

	private onPointer = (e: PointerEvent): void => {
		const i = this.indexAt(e.clientX);
		if (i >= 0) this.setActive(i);
	};

	private onPointerOut = (): void => {
		// A keyboard user's readout stays put when the pointer wanders off (or a touch ends).
		if (this.renderRoot.querySelector(".plot:focus-visible")) return;
		this.setActive(null);
	};

	// ---- render ----

	/** 3-4 nice gridline values covering the domain, widest step first; the domain is widened to them. */
	private gridTicks(lo: number, hi: number): number[] {
		let t = niceTicks(lo, hi, 4);
		for (let c = 3; c >= 1 && t.length > 4; c--) t = niceTicks(lo, hi, c);
		return t.length >= 2 ? t : [lo, hi];
	}

	render() {
		if (this.count() === 0 || this.lines.length === 0) return this.renderEmpty();
		return html`${this.renderReadout()}
			<div
				class="plot"
				part="plot"
				tabindex="0"
				role="img"
				aria-label=${this.plotLabel()}
				style="height:${this.height}px"
				@keydown=${this.onPlotKeydown}
				@blur=${this.onPlotBlur}
				@pointerdown=${this.onPointer}
				@pointermove=${this.onPointer}
				@pointerleave=${this.onPointerOut}
				@pointercancel=${this.onPointerOut}
			>${this.width > 0 ? this.renderSvg() : nothing}</div>
			<div class="dates" part="dates"><span>${formatDay(this.days[0])}</span><span>${formatDay(this.days[this.days.length - 1])}</span></div>
			${this.renderLegend()}
			${this.renderTable()}`;
	}

	private bandSeries(): [TimeseriesSeries & { cls: string }, TimeseriesSeries & { cls: string }] | null {
		const [a, b] = (this.band ?? "").trim().split(/\s+/);
		const sa = this.lines.find((s) => s.y === a);
		const sb = this.lines.find((s) => s.y === b);
		return sa && sb && sa !== sb ? [sa, sb] : null;
	}

	private renderLegend() {
		const band = this.bandSeries();
		if (this.lines.length < 2 && !band) return nothing;
		return html`<div class="legend" part="legend">
			${this.lines.map((s) => html`<span><i class="sw ${s.cls}"></i>${s.label}</span>`)}
			${band && this.bandLabel
				? html`<span><i class="sw wash" style="background:color-mix(in srgb, var(--chart-${band[1].cls.slice(1)}) 12%, transparent)"></i>${this.bandLabel}</span>`
				: nothing}
		</div>`;
	}

	private renderSvg() {
		const w = this.width;
		const h = Math.max(24, this.height || 140);
		const n = this.days.length;
		const goal = this.goalValue();

		const all: number[] = [];
		const values = this.lines.map((s) => this.days.map((_, i) => this.value(s, i)));
		for (const vs of values) for (const v of vs) if (v !== null) all.push(v);
		const [d0, d1] = seriesDomain(all, goal);
		const ticks = this.gridTicks(d0, d1);
		const y = linearScale([ticks[0], ticks[ticks.length - 1]], [h - PAD_BOTTOM, PAD_TOP]);
		const labels = ticks.map((t) => compact(t));

		const cs = getComputedStyle(this);
		const font = `12px ${cs.fontFamily}`;
		const widest = Math.max(0, ...labels.map((l) => measure(l, font) ?? Number.NaN));
		const padR = Number.isFinite(widest) && widest > 0 ? Math.ceil(widest) + LABEL_PAD : FALLBACK_PAD;
		const pw = Math.max(1, w - padR);
		const slot = pw / n;
		const cx = (i: number) => (i + 0.5) * slot;
		this.centres = this.days.map((_, i) => cx(i));

		const pts: Pt[][] = values.map((vs) => vs.map((v, i) => (v === null ? null : { x: cx(i), y: y(v) })));
		const band = this.bandSeries();
		const bandPath = band ? areaPath(pts[this.lines.indexOf(band[0])], pts[this.lines.indexOf(band[1])]) : "";

		// Latest defined point of series 1 gets the end marker.
		let end: { x: number; y: number } | null = null;
		for (let i = n - 1; i >= 0 && !end; i--) end = pts[0][i];

		const gy = goal === undefined ? 0 : Math.round(y(goal)) + 0.5;
		// Goal label sits just above the line, or below it when there's no room above.
		const goalLabelY = gy - 4 - 10 >= 0 ? gy - 4 : gy + 13;
		const a = this.active;

		return svg`<svg width=${w} height=${h} aria-hidden="true">
			${ticks.map((t, k) => {
				const ty = Math.round(y(t)) + 0.5;
				return svg`${goal !== undefined && t === goal ? nothing : svg`<line class="grid" data-v=${t} x1="0" x2=${pw} y1=${ty} y2=${ty}></line>`}
					<text class="tick" x=${w} y=${ty}>${labels[k]}</text>`;
			})}
			${bandPath ? svg`<path class="band" d=${bandPath} style="fill:color-mix(in srgb, var(--chart-${band![1].cls.slice(1)}) 12%, transparent)"></path>` : nothing}
			${goal !== undefined
				? svg`<line class="goal" x1="0" x2=${pw} y1=${gy} y2=${gy}></line>
					<text class="goal-label" x="0" y=${goalLabelY}>${this.goalLabel} ${compact(goal)}</text>`
				: nothing}
			${a !== null ? svg`<line class="cross" x1=${Math.round(cx(a)) + 0.5} x2=${Math.round(cx(a)) + 0.5} y1="0" y2=${h}></line>` : nothing}
			${this.lines.map((s, k) => svg`<path class="line ${s.cls}" data-y=${s.y} d=${linePath(pts[k])}></path>`)}
			${end ? svg`<circle class="end s1" cx=${end.x} cy=${end.y} r="4"></circle>` : nothing}
			${a !== null ? this.lines.map((s, k) => (pts[k][a] ? svg`<circle class="ring ${s.cls}" cx=${pts[k][a]!.x} cy=${pts[k][a]!.y} r="4"></circle>` : nothing)) : nothing}
		</svg>`;
	}
}

customElements.define("tk-timeseries", TkTimeseries);
