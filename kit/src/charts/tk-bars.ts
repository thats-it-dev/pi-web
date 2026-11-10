import { type PropertyDeclarations, type PropertyValues, css, html, nothing } from "lit";
import { ChartBase } from "./chart-base.ts";
import { GOAL_AT, atGoal, barFraction } from "./bars.ts";
import { formatValue } from "./format.ts";

type Row = { label: string; value: number | null; raw: unknown };

/**
 * A list of labelled bars against an optional goal. Rows keep the data order; every row has the
 * goal tick at the same x (80% of the track). Status is always written in words, never color alone.
 *
 *     <tk-bars .data=${keys} label="key" value="wpm" goal="40" unit="wpm"></tk-bars>
 *
 * `lower` flips the direction (ms between keys: faster is better and gets the longer bar).
 * The `tk-readout` datum is the row object.
 */
export class TkBars extends ChartBase {
	static properties: PropertyDeclarations = {
		unit: {},
		summary: {},
		empty: {},
		label: {},
		value: {},
		goal: { type: Number },
		lower: { type: Boolean },
	};
	declare label: string;
	declare value: string;
	declare goal: number | undefined;
	declare lower: boolean;

	static styles = [
		ChartBase.styles,
		css`
			.plot { cursor: default; display: grid; gap: 8px; }
			.row { display: block; }
			.head { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; line-height: 1.4; }
			.name { font-weight: 700; color: var(--text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.val { color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
			.track { position: relative; height: 8px; margin-top: 2px; border-radius: 4px; background: var(--panel); }
			.fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; background: var(--chart-1); transition: opacity 0.12s; }
			.fill.under { background: var(--chart-2); }
			.tick { position: absolute; top: -2px; bottom: -2px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--text-primary); }
			.dim .fill { opacity: 0.55; }
			.dim .row.on .fill { opacity: 1; }
			.on .name, .on .val { color: var(--text-primary); }
			@media (forced-colors: active) {
				.fill { background: Highlight; } .track { background: GrayText; } .tick { background: CanvasText; }
			}
		`,
	];

	private rows: Row[] = [];
	private maxValue = 0;

	constructor() {
		super();
		this.label = "label";
		this.value = "value";
		this.goal = undefined;
		this.lower = false;
	}

	protected willUpdate(changed: PropertyValues<this>): void {
		// count() derives from these, so compute before the base clamps `active`.
		this.rows = (this.data ?? []).map((r) => {
			const rec = (r ?? {}) as Record<string, unknown>;
			const v = rec[this.value];
			return { label: String(rec[this.label] ?? ""), value: typeof v === "number" && Number.isFinite(v) ? v : null, raw: r };
		});
		this.maxValue = Math.max(0, ...this.rows.map((r) => r.value ?? 0));
		super.willUpdate(changed);
	}

	private goalValue(): number | undefined {
		const g = this.goal;
		return typeof g === "number" && Number.isFinite(g) && g > 0 ? g : undefined;
	}

	private fmt(v: number | null): string {
		return v === null ? "—" : formatValue(v, this.unit, this.format);
	}

	private reached(r: Row): boolean {
		const g = this.goalValue();
		return g === undefined || r.value === null ? true : atGoal(r.value, g, this.lower);
	}

	// ---- ChartBase ----

	protected count(): number {
		return this.rows.length;
	}

	protected datum(i: number): unknown {
		return this.rows[i]?.raw ?? null;
	}

	private atGoalCount(): number {
		return this.rows.filter((r) => r.value !== null && this.reached(r)).length;
	}

	private parts(i: number | null): { text: string; value: string; status: string } | null {
		if (i === null) {
			if (this.goalValue() === undefined) return null;
			return { text: `${this.atGoalCount()} of ${this.rows.length} at goal`, value: "", status: "" };
		}
		const r = this.rows[i];
		if (!r) return null;
		const status = this.goalValue() === undefined ? "" : this.reached(r) ? "at goal" : "below goal";
		return { text: [r.label, this.fmt(r.value), status].filter(Boolean).join(" · "), value: this.fmt(r.value), status };
	}

	protected readoutText(i: number | null): string {
		return this.parts(i)?.text ?? "";
	}

	protected readoutContent(i: number | null): unknown {
		const p = this.parts(i);
		if (!p) return "";
		if (i === null) return p.text;
		const r = this.rows[i];
		return html`${r.label} · <b>${p.value}</b>${p.status ? ` · ${p.status}` : nothing}`;
	}

	protected tableRows(): { head: string[]; rows: string[][] } {
		const goal = this.goalValue() !== undefined;
		return {
			head: [this.label, this.unit || this.value, ...(goal ? ["Goal"] : [])],
			rows: this.rows.map((r) => [r.label, this.fmt(r.value), ...(goal ? [this.reached(r) ? "at goal" : "below goal"] : [])]),
		};
	}

	protected autoSummary(): string {
		const n = this.rows.length;
		const out = [`${n} ${n === 1 ? "row" : "rows"}.`];
		const have = this.rows.filter((r) => r.value !== null);
		if (have.length > 1) {
			const hi = have.reduce((a, b) => (b.value! > a.value! ? b : a));
			const lo = have.reduce((a, b) => (b.value! < a.value! ? b : a));
			out.push(`Highest ${hi.label} ${this.fmt(hi.value)}, lowest ${lo.label} ${this.fmt(lo.value)}.`);
		}
		const g = this.goalValue();
		if (g !== undefined) out.push(`${this.atGoalCount()} at goal ${this.fmt(g)}.`);
		return out.join(" ");
	}

	// ---- pointer ----

	private onEnter(i: number): void {
		this.setActive(i);
	}

	private onLeave = (): void => {
		// A keyboard user's readout stays put when the pointer wanders off.
		if (this.renderRoot.querySelector(".plot:focus-visible")) return;
		this.setActive(null);
	};

	// ---- render ----

	render() {
		if (this.count() === 0) return this.renderEmpty();
		const goal = this.goalValue();
		const a = this.active;
		return html`${this.renderReadout()}
			<div
				class="plot ${a !== null ? "dim" : ""}"
				part="plot"
				tabindex="0"
				role="img"
				aria-label=${this.plotLabel()}
				@keydown=${this.onPlotKeydown}
				@blur=${this.onPlotBlur}
				@pointerleave=${this.onLeave}
				@pointercancel=${this.onLeave}
			>
				${this.rows.map((r, i) => {
					const f = r.value === null ? 0 : barFraction(r.value, { goal, lower: this.lower, max: this.maxValue });
					const under = goal !== undefined && !this.reached(r);
					return html`<div
						class="row ${a === i ? "on" : ""}"
						@pointerdown=${() => this.onEnter(i)}
						@pointerenter=${() => this.onEnter(i)}
						@pointermove=${() => this.onEnter(i)}
					>
						<div class="head"><span class="name">${r.label}</span><span class="val">${this.fmt(r.value)}</span></div>
						<div class="track"><div class="fill ${under ? "under" : ""}" style="width:${(f * 100).toFixed(2)}%"></div>${goal !== undefined ? html`<div class="tick" style="left:${GOAL_AT * 100}%"></div>` : nothing}</div>
					</div>`;
				})}
			</div>
			${this.renderTable()}`;
	}
}

customElements.define("tk-bars", TkBars);
