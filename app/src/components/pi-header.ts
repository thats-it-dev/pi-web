import { LitElement, css, html, nothing } from "lit";
import { sharedStyles } from "@thatsit/kit";
import { formatCost, formatTokens } from "../lib/format.ts";
import { contextLabel, speedLabel } from "../lib/live-stats.ts";
import type { SessionStore } from "../lib/session-store.ts";
import { hrefFor } from "../lib/route.ts";
import { headerStatus } from "../lib/status.ts";

// Lucide icon (ISC): square-pen.
const NEW_CHAT_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" /></svg>`;

export class PiHeader extends LitElement {
	static properties = { store: { attribute: false }, draft: { attribute: false }, version: { attribute: false }, heading: { attribute: false }, tucked: { type: Boolean } };
	declare store: SessionStore | null;
	declare draft: { contextWindow: number } | null; // an unsent chat: no session yet, just the chosen model's window
	declare version: number;
	declare heading: string;
	declare tucked: boolean;

	static styles = [
		sharedStyles,
		css`
			/* tk-header is the sticky bar; this host must not box it in, or sticky would stick within it */
			:host { display: contents; }
			.l2 { display: grid; grid-template-columns: minmax(40px, 1fr) auto; gap: 10px; align-items: center; width: 100%; text-align: left; font-size: 0.72rem; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
			.meter { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; display: block; }
			.meter i { display: block; height: 100%; background: var(--primary); transition: width 0.4s ease; }
			.meter.hot i { background: var(--accent); }
			.new { display: grid; place-items: center; width: 32px; height: 32px; margin: -6px -6px -6px 0; color: var(--text-secondary); }
			.new svg { width: 20px; height: 20px; }
			.state { font-size: 0.72rem; color: var(--text-muted); font-style: italic; }
		`,
	];

	constructor() {
		super();
		this.store = null;
		this.draft = null;
		this.version = 0;
		this.heading = "";
		this.tucked = false;
	}

	private emit(type: string, detail?: unknown): void {
		this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
	}

	render() {
		if (this.draft) return this.frame("new chat", 0, `0 / ${formatTokens(this.draft.contextWindow)} (0%) · — t/s`, null);
		const s = this.store;
		if (!s) return nothing;
		const snap = s.snapshot;
		const stats = snap?.stats ?? null;
		const ctx = s.live.context();
		const known = stats?.contextUsage; // pi can't always count it (just after a compaction)
		const pct = ctx?.percent ?? null;
		const speed = s.live.speed();
		const t = stats?.tokens;
		const nums = [
			ctx ? contextLabel(ctx) : known ? `— / ${formatTokens(known.contextWindow)}` : "—",
			t ? `↑${formatTokens(t.input + t.cacheRead)} ↓${formatTokens(t.output)}` : null,
			stats?.cost ? formatCost(stats.cost) : null,
			speed ? speedLabel(speed) : null,
		]
			.filter(Boolean)
			.join(" · ");
		return this.frame(this.heading, pct, nums, headerStatus(s));
	}

	private frame(heading: string, pct: number | null, nums: string, status: string | null) {
		return html`<tk-header ?tucked=${this.tucked} menu-label="Open sessions">
			<h1 slot="title">${heading}</h1>
			<button slot="actions" class="new" aria-label="New chat" @click=${() => (location.hash = hrefFor({ name: "new" }))}>${NEW_CHAT_ICON}</button>
			<button class="l2" aria-label="Session stats" @click=${() => this.emit("pi-open-sheet", "stats")}>
				<span class="meter ${pct != null && pct >= 80 ? "hot" : ""}"><i style=${`width:${Math.min(100, Math.max(0, pct ?? 0))}%`}></i></span>
				<span>${nums}</span>
			</button>
			${status ? html`<div class="state" role="status">${status}</div>` : nothing}
		</tk-header>`;
	}
}
customElements.define("pi-header", PiHeader);
