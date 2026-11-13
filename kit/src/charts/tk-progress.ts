import { LitElement, css, html, nothing } from "lit";
import { compact } from "./format.ts";
import { progressFraction } from "./progress.ts";

/**
 * A single progress bar: a track with a filled portion, a `value / max` readout,
 * and a "goal reached" line once the value has hit or passed the max.
 *
 *     <tk-progress .value=${minutes} .max=${goalMinutes} label="today" unit="min"></tk-progress>
 *
 * The fill switches to the success color and the word appears when `value >= max` —
 * the word, not just a full bar, is the signal that the goal was reached.
 */
export class TkProgress extends LitElement {
	static properties = {
		value: { attribute: false },
		max: { attribute: false },
		label: { type: String },
		unit: { type: String },
	};
	declare value: number;
	declare max: number;
	declare label: string;
	declare unit: string;

	static styles = css`
		:host {
			display: block; box-sizing: border-box; width: 100%; max-width: 30rem;
			background: var(--panel); border-radius: var(--radius); padding: 10px 12px;
			color: var(--text-primary);
		}
		.label { font-size: 13px; line-height: 1.4; color: var(--text-secondary); }
		.nums { font-size: 20px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; margin-top: 2px; }
		.track {
			position: relative; height: 10px; margin-top: 8px;
			border-radius: 5px; background: var(--bg); overflow: hidden;
		}
		.fill {
			position: absolute; left: 0; top: 0; bottom: 0;
			background: var(--chart-1); border-radius: 5px; transition: width 0.15s ease;
		}
		.fill.done { background: var(--success); }
		.done { font-size: 12px; color: var(--success); margin-top: 4px; }
		@media (forced-colors: active) {
			.track { background: GrayText; }
			.fill, .fill.done { background: Highlight; }
		}
		@media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
	`;

	constructor() {
		super();
		this.value = 0;
		this.max = 0;
		this.label = "";
		this.unit = "";
	}

	render() {
		const v = Number.isFinite(this.value) ? this.value : 0;
		const m = Number.isFinite(this.max) ? this.max : 0;
		const frac = progressFraction(v, m);
		const pct = Math.floor(frac * 100);
		const reached = m > 0 && v >= m;
		return html`
			${this.label ? html`<div class="label">${this.label}</div>` : nothing}
			<div class="nums">${compact(v)} / ${compact(m)}${this.unit ? ` ${this.unit}` : nothing}</div>
			<div class="track" role="progressbar" aria-label=${this.label || "progress"} aria-valuemin="0" aria-valuemax=${m} aria-valuenow=${Math.min(v, m)}>
				<div class="fill ${reached ? "done" : ""}" style="width:${pct}%"></div>
			</div>
			${reached ? html`<div class="done">goal reached</div>` : nothing}
		`;
	}
}

customElements.define("tk-progress", TkProgress);
