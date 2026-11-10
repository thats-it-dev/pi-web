import { LitElement, css, svg } from "lit";
import { linePath } from "./path.ts";
import { linearScale, seriesDomain } from "./scale.ts";

// A single 2px series line with an end dot. No axes or text. Sized by CSS (default 110 x 40).
export class TkSparkline extends LitElement {
	static properties = { values: { attribute: false } };
	declare values: number[];

	static styles = css`
		:host { display: block; width: 110px; height: 40px; }
		svg { display: block; width: 100%; height: 100%; overflow: visible; }
		path { fill: none; stroke: var(--chart-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
		circle { fill: var(--chart-1); stroke: var(--tk-chart-surface, var(--bg)); stroke-width: 2; }
	`;

	private ro?: ResizeObserver;
	private w = 110;
	private h = 40;

	constructor() {
		super();
		this.values = [];
	}

	connectedCallback() {
		super.connectedCallback();
		this.ro = new ResizeObserver(([e]) => {
			const { width, height } = e.contentRect;
			if (width && height && (width !== this.w || height !== this.h)) {
				this.w = width;
				this.h = height;
				this.requestUpdate();
			}
		});
		this.ro.observe(this);
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		this.ro?.disconnect();
	}

	render() {
		const vals = (this.values ?? []).filter(Number.isFinite);
		if (vals.length === 0) return svg``;
		const pad = 5.5; // room for the end dot (r 3.5 + 2px ring) so it is never clipped
		const [lo, hi] = seriesDomain(vals);
		const y = linearScale([lo, hi], [this.h - pad, pad]);
		const x = linearScale([0, Math.max(1, vals.length - 1)], [pad, this.w - pad]);
		const pts = vals.map((v, i) => ({ x: x(i), y: y(v) }));
		const last = pts[pts.length - 1];
		return svg`<svg viewBox="0 0 ${this.w} ${this.h}" aria-hidden="true"><path d=${linePath(pts)}></path><circle cx=${last.x} cy=${last.y} r="3.5"></circle></svg>`;
	}
}

customElements.define("tk-sparkline", TkSparkline);
