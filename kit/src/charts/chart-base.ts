import { LitElement, type PropertyValues, type TemplateResult, css, html } from "lit";
import { sharedStyles } from "../styles.ts";
import { clampIndex, stepIndex } from "./step.ts";

export { clampIndex, stepIndex } from "./step.ts";

/** Detail of the bubbling, composed `tk-readout` event: the active index (null = rest) and its datum. */
export type ReadoutDetail = { index: number | null; datum: unknown };

/** Delay of the trailing throttle on the aria-live readout, so scrubbing doesn't spam a screen reader. */
const LIVE_MS = 400;

/**
 * Styles every chart shares: the readout line, the plot's focus ring, the empty line,
 * and no transitions under reduced motion. Subclasses compose them:
 * `static styles = [ChartBase.styles, css\`…\`]`.
 */
export const chartBaseStyles = [
	sharedStyles,
	css`
		:host { display: block; position: relative; }
		.readout {
			margin: 0 0 6px; font-size: 13px; line-height: 1.4; height: 1.4em; color: var(--text-secondary);
			white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		}
		.readout b { font-weight: 600; color: var(--text-primary); }
		.plot { position: relative; outline: none; }
		.plot:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 2px; }
		.empty { margin: 0; font-size: 13px; color: var(--text-secondary); }
		@media (prefers-reduced-motion: reduce) {
			*, *::before, *::after { transition: none !important; animation: none !important; }
		}
	`,
];

/**
 * Abstract base of the interactive charts (tk-timeseries, tk-bars, tk-heatmap).
 *
 * Owns: the readout line above the plot, keyboard stepping, the throttled aria-live
 * region, the `tk-readout` event, the visually hidden data table, the empty line and
 * the host width (ResizeObserver).
 *
 * Subclasses MUST list the public attributes literally in their own `static properties`
 * (the api.json scanner only reads literal objects on files that define an element):
 *
 *     static properties = { unit: {}, summary: {}, empty: {}, …their own };
 *
 * `data`, `format`, `active` and `width` come from this class (Lit merges them).
 *
 * The plot element a subclass renders should be:
 *
 *     <div class="plot" part="plot" tabindex="0" role="img" aria-label=${this.plotLabel()}
 *          @keydown=${this.onPlotKeydown} @blur=${this.onPlotBlur}>…</div>
 *
 * Pointer handlers call `this.setActive(i)` / `this.setActive(null)`.
 * Overrides of `willUpdate`, `connectedCallback` or `disconnectedCallback` must call super.
 */
export abstract class ChartBase extends LitElement {
	static properties = {
		data: { attribute: false },
		format: { attribute: false },
		active: { state: true },
		width: { state: true },
	};
	declare data: readonly unknown[];
	declare format: ((n: number) => string) | undefined;
	declare active: number | null;
	declare width: number;
	// Declared here, made reactive by each subclass's literal `static properties`.
	declare unit: string;
	declare summary: string;
	declare empty: string;

	static styles = chartBaseStyles;

	private ro?: ResizeObserver;
	private liveText = "";
	private liveTimer: ReturnType<typeof setTimeout> | undefined;

	constructor() {
		super();
		this.data = [];
		this.format = undefined;
		this.active = null;
		this.width = 0;
		this.unit = "";
		this.summary = "";
		this.empty = "";
	}

	/** Number of steppable items (points, rows or days). */
	protected abstract count(): number;
	/** Payload for `tk-readout` at index `i`. */
	protected abstract datum(i: number): unknown;
	/** Plain readout text at `i`, or the rest state when `i` is null. Also what the live region announces. */
	protected abstract readoutText(i: number | null): string;
	/** Data for the visually hidden table. The first cell of each row is its row header. */
	protected abstract tableRows(): { head: string[]; rows: string[][] };
	/** Generated summary for the plot's aria-label (count, range, latest, best, goal). */
	protected abstract autoSummary(): string;

	/** Up/Down step size, or undefined to leave Up/Down unhandled (page scroll). The heatmap returns 7. */
	protected vstep(): number | undefined {
		return undefined;
	}

	/** Visible readout content at `i`. Defaults to `readoutText(i)`; override to wrap values in `<b>` or add swatches. */
	protected readoutContent(i: number | null): unknown {
		return this.readoutText(i);
	}

	/** Moves the readout to `i` (null = rest): clamps, fires `tk-readout` and schedules the live text. No-op if unchanged. */
	protected setActive(i: number | null): void {
		const next = clampIndex(i, this.count());
		if (next === this.active) return;
		this.active = next;
		const detail: ReadoutDetail = { index: next, datum: next === null ? null : this.datum(next) };
		this.dispatchEvent(new CustomEvent<ReadoutDetail>("tk-readout", { detail, bubbles: true, composed: true }));
		this.scheduleLive();
	}

	// Trailing throttle: the first change opens a window, the text at its end is announced.
	private scheduleLive(): void {
		if (this.liveTimer !== undefined) return;
		this.liveTimer = setTimeout(() => {
			this.liveTimer = undefined;
			this.liveText = this.readoutText(this.active);
			this.requestUpdate();
		}, LIVE_MS);
	}

	/** Keydown on the plot: Left/Right, Home/End, Escape, and Up/Down when `vstep()` is set. */
	protected onPlotKeydown = (e: KeyboardEvent): void => {
		if (e.altKey || e.ctrlKey || e.metaKey) return;
		// Escape at rest is not ours, so an enclosing sheet can still close.
		if (e.key === "Escape" && this.active === null) return;
		const next = stepIndex(this.active, e.key, this.count(), this.vstep());
		if (next === undefined) return;
		e.preventDefault();
		if (e.key === "Escape") e.stopPropagation();
		this.setActive(next);
	};

	/** Blur on the plot returns the readout to rest. */
	protected onPlotBlur = (): void => {
		this.setActive(null);
	};

	/** The one-line readout (fixed height, never shifts layout) plus the visually hidden live region. */
	protected renderReadout(): TemplateResult {
		return html`<p class="readout" part="readout">${this.readoutContent(this.active)}</p><span class="sr-only" aria-live="polite">${this.liveText}</span>`;
	}

	/** The plot's aria-label: the app's `summary` if set, else the generated one. */
	protected plotLabel(): string {
		return this.summary || this.autoSummary();
	}

	/** The data as a visually hidden table, so nothing is hover-only or color-only. */
	protected renderTable(): TemplateResult {
		const { head, rows } = this.tableRows();
		return html`<table class="sr-only">
			<caption>${this.plotLabel()}</caption>
			<thead><tr>${head.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead>
			<tbody>${rows.map((r) => html`<tr>${r.map((c, j) => (j === 0 ? html`<th scope="row">${c}</th>` : html`<td>${c}</td>`))}</tr>`)}</tbody>
		</table>`;
	}

	/** One quiet line in place of the plot when there is no data. */
	protected renderEmpty(): TemplateResult {
		return html`<p class="empty" part="empty">${this.empty || "No data yet"}</p>`;
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.ro = new ResizeObserver(([e]) => {
			const w = Math.floor(e.contentRect.width);
			if (w !== this.width) this.width = w;
		});
		this.ro.observe(this);
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		this.ro?.disconnect();
		clearTimeout(this.liveTimer);
		this.liveTimer = undefined;
	}

	// Clamp before render (not in updated()) so a shrunk data set never renders a stale index.
	protected willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("data")) this.active = clampIndex(this.active, this.count());
	}
}
