import { LitElement, css, html, nothing } from "lit";
import { compact } from "./format.ts";
import "./tk-sparkline.ts";

// One stat tile: label, big value, optional change line and (when wide) a sparkline.
export class TkStat extends LitElement {
	static properties = {
		label: { type: String },
		value: { attribute: true },
		unit: { type: String },
		change: { type: String },
		good: { type: String },
		trend: { attribute: false },
		wide: { type: Boolean, reflect: true },
	};
	declare label: string;
	declare value: string | number;
	declare unit: string;
	declare change: string;
	declare good: "up" | "down" | "";
	declare trend: number[];
	declare wide: boolean;

	static styles = css`
		:host {
			display: block; box-sizing: border-box; min-width: 0;
			background: var(--panel); border-radius: var(--radius); padding: 8px 10px;
			color: var(--text-primary); --tk-spark-ring: var(--panel);
		}
		:host([wide]) { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
		.text { min-width: 0; }
		.label { font-size: 13px; line-height: 1.3; color: var(--text-secondary); }
		.value { font-size: 24px; font-weight: 700; line-height: 1.15; font-variant-numeric: proportional-nums; }
		.change { font-size: 12px; line-height: 1.3; color: var(--text-secondary); }
		.change.up.good-up, .change.down.good-down { color: var(--success); }
		.change.up.good-down, .change.down.good-up { color: var(--accent); }
		tk-sparkline { flex: 0 1000 110px; min-width: 56px; }
	`;

	constructor() {
		super();
		this.label = "";
		this.value = "";
		this.unit = "";
		this.change = "";
		this.good = "";
		this.trend = [];
		this.wide = false;
	}

	render() {
		const raw = this.value;
		// Numbers (and numeric attribute strings) compact; anything else shows as written.
		const numeric = typeof raw === "number" || (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim()));
		const v = numeric ? compact(Number(raw)) : String(raw ?? "");
		const first = (this.change ?? "").trim().charAt(0);
		const dir = first === "+" ? "up" : first === "-" || first === "−" ? "down" : "";
		const cls = `change ${dir} ${this.good ? `good-${this.good}` : ""}`;
		return html`
			<div class="text">
				<div class="label">${this.label}</div>
				<div class="value">${v}${this.unit ? ` ${this.unit}` : nothing}</div>
				${this.change ? html`<div class=${cls}>${this.change}</div>` : nothing}
			</div>
			${this.wide && this.trend?.length ? html`<tk-sparkline .values=${this.trend}></tk-sparkline>` : nothing}
		`;
	}
}

customElements.define("tk-stat", TkStat);
