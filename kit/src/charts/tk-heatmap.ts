import { type PropertyDeclarations, type PropertyValues, css, html, nothing } from "lit";
import { ChartBase } from "./chart-base.ts";
import { dayKey } from "./days.ts";
import { formatDay, formatValue } from "./format.ts";
import { type HeatCell, fitWeeks, heatLayout, heatLevel } from "./heat.ts";

const GAP = 4;

/**
 * A calendar heatmap: weeks are columns, Monday-first weekdays are rows, the last column ends at `end`.
 * Cells shrink (never below 10px) and then the oldest weeks drop, so the grid never overflows.
 *
 *     <tk-heatmap .data=${days} x="day" value="minutes" unit="min" weeks="12" legend></tk-heatmap>
 *
 * A day with no row and a day with value 0 look the same. The `tk-readout` datum is the day's row
 * (or `{ day }` for an empty day).
 */
export class TkHeatmap extends ChartBase {
	static properties: PropertyDeclarations = {
		unit: {},
		summary: {},
		empty: {},
		x: {},
		value: {},
		weeks: { type: Number },
		end: {},
		legend: { type: Boolean },
	};
	declare x: string;
	declare value: string;
	declare weeks: number;
	declare end: string;
	declare legend: boolean;

	static styles = [
		ChartBase.styles,
		css`
			.plot { cursor: default; }
			.months, .grid { display: grid; grid-template-columns: repeat(var(--cols), var(--cell)); column-gap: ${GAP}px; }
			.months { height: 16px; margin-bottom: 4px; font-size: 12px; line-height: 16px; color: var(--text-secondary); }
			.months span { white-space: nowrap; }
			.months span.last { justify-self: end; }
			.grid { grid-template-rows: repeat(7, var(--cell)); row-gap: ${GAP}px; }
			.cell { border-radius: 2px; background: var(--panel); }
			.l1 { background: color-mix(in srgb, var(--chart-1) 30%, var(--panel)); }
			.l2 { background: color-mix(in srgb, var(--chart-1) 52%, var(--panel)); }
			.l3 { background: color-mix(in srgb, var(--chart-1) 76%, var(--panel)); }
			.l4 { background: var(--chart-1); }
			.cell.on { outline: 2px solid var(--text-primary); outline-offset: 0; }
			.legend { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 8px; font-size: 12px; line-height: 16px; color: var(--text-secondary); }
			.legend i { width: 10px; height: 10px; border-radius: 2px; background: var(--panel); }
			.legend i.l1 { background: color-mix(in srgb, var(--chart-1) 30%, var(--panel)); }
			.legend i.l2 { background: color-mix(in srgb, var(--chart-1) 52%, var(--panel)); }
			.legend i.l3 { background: color-mix(in srgb, var(--chart-1) 76%, var(--panel)); }
			.legend i.l4 { background: var(--chart-1); }
			@media (forced-colors: active) {
				.cell { background: GrayText; } .cell.l0 { background: Canvas; border: 1px solid GrayText; } .cell.on { outline-color: CanvasText; }
			}
		`,
	];

	private cells: HeatCell[] = [];
	private months: { col: number; day: string }[] = [];
	private cellPx = 18;
	private values = new Map<string, number>();
	private rows = new Map<string, unknown>();
	private maxValue = 0; // levels are relative to the max over the visible cells
	private activeDay = "";
	private monthFmt = new Intl.DateTimeFormat(undefined, { month: "short" });

	constructor() {
		super();
		this.x = "day";
		this.value = "value";
		this.weeks = 12;
		this.end = ""; // empty = today, resolved at layout time so it never goes stale
		this.legend = false;
	}

	protected willUpdate(changed: PropertyValues<this>): void {
		// count() derives from the layout, so compute before the base clamps `active`.
		const fitted = fitWeeks(this.width, Math.max(1, Math.floor(this.weeks) || 12));
		this.cellPx = fitted.cell;
		const end = this.end || (dayKey(new Date()) ?? "");
		const lay = this.width > 0 && (this.data?.length ?? 0) > 0 ? heatLayout(end, fitted.weeks) : { cells: [], months: [] };
		const prev = this.cells;
		const same = prev.length === lay.cells.length && prev[0]?.day === lay.cells[0]?.day;
		this.cells = lay.cells;
		// A rebuilt layout renumbers the cells: keep the readout on the same day, or drop it if that day left the grid.
		if (!same && this.active !== null && this.activeDay) {
			const at = this.cells.findIndex((c) => c.day === this.activeDay);
			if (at < 0) this.setActive(null);
			else this.active = at;
		}
		this.months = lay.months;
		this.values = new Map();
		this.rows = new Map();
		for (const r of this.data ?? []) {
			const rec = (r ?? {}) as Record<string, unknown>;
			const d = dayKey(rec[this.x] as string | Date | number | null);
			const v = rec[this.value];
			if (d === null || typeof v !== "number" || !Number.isFinite(v)) continue;
			this.values.set(d, (this.values.get(d) ?? 0) + v);
			this.rows.set(d, r);
		}
		this.maxValue = Math.max(0, ...this.cells.map((c) => this.values.get(c.day) ?? 0));
		super.willUpdate(changed);
		this.activeDay = this.active === null ? "" : (this.cells[this.active]?.day ?? "");
	}

	private fmt(v: number): string {
		return formatValue(v, this.unit, this.format);
	}

	private valueOf(i: number): number {
		return this.values.get(this.cells[i]?.day ?? "") ?? 0;
	}

	// ---- ChartBase ----

	protected count(): number {
		return this.cells.length;
	}

	protected datum(i: number): unknown {
		const c = this.cells[i];
		return c ? (this.rows.get(c.day) ?? { day: c.day }) : null;
	}

	protected vstep(): number {
		return 7;
	}

	protected readoutText(i: number | null): string {
		if (i === null) {
			const days = this.cells.filter((c) => (this.values.get(c.day) ?? 0) > 0);
			const total = days.reduce((n, c) => n + (this.values.get(c.day) ?? 0), 0);
			return `${days.length} ${days.length === 1 ? "day" : "days"} · ${this.fmt(total)}`;
		}
		const c = this.cells[i];
		if (!c) return "";
		const v = this.valueOf(i);
		return `${formatDay(c.day)} · ${v > 0 ? this.fmt(v) : "none"}`;
	}

	protected tableRows(): { head: string[]; rows: string[][] } {
		return {
			head: [this.x, this.unit || this.value],
			rows: this.cells.map((c) => [c.day, this.values.has(c.day) ? this.fmt(this.values.get(c.day)!) : "none"]),
		};
	}

	protected autoSummary(): string {
		const first = this.cells[0]?.day;
		const last = this.cells[this.cells.length - 1]?.day;
		return first && last ? `${this.readoutText(null)}, ${formatDay(first)} to ${formatDay(last)}.` : "";
	}

	// ---- pointer ----

	private onLeave = (): void => {
		// A keyboard user's readout stays put when the pointer wanders off.
		if (this.renderRoot.querySelector(".plot:focus-visible")) return;
		this.setActive(null);
	};

	private level(i: number): number {
		return heatLevel(this.valueOf(i), this.maxValue);
	}

	// ---- render ----

	render() {
		if ((this.data?.length ?? 0) === 0) return this.renderEmpty();
		if (this.cells.length === 0) return html`${this.renderReadout()}`;
		const cols = this.cells[this.cells.length - 1].col + 1;
		const a = this.active;
		return html`${this.renderReadout()}
			<div
				class="plot"
				part="plot"
				tabindex="0"
				role="img"
				aria-label=${this.plotLabel()}
				style="--cols:${cols};--cell:${this.cellPx}px;width:${cols * this.cellPx + (cols - 1) * GAP}px;max-width:100%"
				@keydown=${this.onPlotKeydown}
				@blur=${this.onPlotBlur}
				@pointerleave=${this.onLeave}
				@pointercancel=${this.onLeave}
			>
				<div class="months" aria-hidden="true">${this.months.map((m) => html`<span class=${m.col === cols - 1 ? "last" : ""} style="grid-column:${m.col + 1} / span ${m.col === cols - 1 ? 1 : 2}">${this.monthFmt.format(new Date(+m.day.slice(0, 4), +m.day.slice(5, 7) - 1, 1, 12))}</span>`)}</div>
				<div class="grid">
					${this.cells.map(
						(c, i) => html`<div
							class="cell l${this.level(i)} ${a === i ? "on" : ""}"
							data-day=${c.day}
							style="grid-column:${c.col + 1};grid-row:${c.row + 1}"
							@pointerdown=${() => this.setActive(i)}
							@pointerenter=${() => this.setActive(i)}
							@pointermove=${() => this.setActive(i)}
						></div>`,
					)}
				</div>
			</div>
			${this.legend ? html`<div class="legend" aria-hidden="true">less ${[0, 1, 2, 3, 4].map((l) => html`<i class="l${l}"></i>`)} more</div>` : nothing}
			${this.renderTable()}`;
	}
}

customElements.define("tk-heatmap", TkHeatmap);
