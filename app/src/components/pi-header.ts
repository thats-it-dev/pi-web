import { LitElement, css, html, nothing } from "lit";
import { formatCost, formatTokens } from "../lib/format.ts";
import type { SessionStore } from "../lib/session-store.ts";
import { sharedStyles } from "../styles/shared.ts";

export function headerStatus(s: SessionStore): string | null {
	switch (s.status) {
		case "loading":
			return "loading…";
		case "starting":
			return "starting pi…";
		case "reconnecting":
			return "reconnecting…";
		case "history":
			return s.lastExit ? `pi stopped: ${s.lastExit.split("\n").at(-1)}. Send a message to restart it.` : "pi isn't running for this session. Sending a message starts it.";
	}
	if (s.conv.retry) return `retrying (${s.conv.retry.attempt}/${s.conv.retry.max})…`;
	if (s.conv.compacting) return "compacting…";
	if (s.snapshot?.handleKind === "bridge") return "open in terminal";
	return null;
}

export class PiHeader extends LitElement {
	static properties = { store: { attribute: false }, version: { attribute: false }, heading: { attribute: false } };
	declare store: SessionStore | null;
	declare version: number;
	declare heading: string;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); padding-top: env(safe-area-inset-top); transition: transform 0.2s ease; }
			header { display: grid; gap: 6px; padding: 10px 18px 9px; }
			.l1 { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
			.menu { display: none; font-size: 1.2rem; line-height: 1; align-self: center; }
			h1 { font-family: var(--font-display); font-weight: 400; font-size: 1.15rem; letter-spacing: 0.02em; margin: 0; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.model { color: var(--accent); font-size: 0.8rem; white-space: nowrap; }
			.model b { font-weight: 500; }
			.l2 { display: grid; grid-template-columns: minmax(40px, 1fr) auto; gap: 10px; align-items: center; width: 100%; text-align: left; font-size: 0.72rem; color: var(--text-2); font-variant-numeric: tabular-nums; }
			.meter { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; display: block; }
			.meter i { display: block; height: 100%; background: var(--accent); transition: width 0.4s ease; }
			.meter.hot i { background: var(--primary); }
			.state { font-size: 0.72rem; color: var(--muted); font-style: italic; }
			@media (max-width: 899px) {
				header { padding: 8px 14px; }
				.menu { display: inline-block; }
				:host([tucked]) { transform: translateY(-100%); }
			}
		`,
	];

	constructor() {
		super();
		this.store = null;
		this.version = 0;
		this.heading = "";
	}

	private emit(type: string, detail?: unknown): void {
		this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
	}

	render() {
		const s = this.store;
		if (!s) return nothing;
		const snap = s.snapshot;
		const model = snap?.state.model ?? null;
		const stats = snap?.stats ?? null;
		const ctx = stats?.contextUsage;
		const pct = ctx?.percent ?? null;
		const t = stats?.tokens;
		const status = headerStatus(s);
		const nums = [
			ctx ? `${ctx.tokens == null ? "—" : formatTokens(ctx.tokens)} / ${formatTokens(ctx.contextWindow)}` : "—",
			t ? `↑${formatTokens(t.input + t.cacheRead)} ↓${formatTokens(t.output)}` : null,
			stats?.cost ? formatCost(stats.cost) : null,
		]
			.filter(Boolean)
			.join(" · ");
		return html`<header>
			<div class="l1">
				<button class="menu" aria-label="Open sessions" @click=${() => this.emit("pi-open-nav")}>☰</button>
				<h1>${this.heading}</h1>
				<button class="model u" aria-label=${`Model ${model?.name ?? "not loaded"}`} @click=${() => this.emit("pi-open-sheet", "model")}>
					${model ? html`<b>${model.name}</b> · ${snap?.state.thinkingLevel}` : "model"}
				</button>
			</div>
			<button class="l2" aria-label="Session stats" @click=${() => this.emit("pi-open-sheet", "stats")}>
				<span class="meter ${pct != null && pct >= 80 ? "hot" : ""}"><i style=${`width:${Math.min(100, Math.max(0, pct ?? 0))}%`}></i></span>
				<span>${nums}</span>
			</button>
			${status ? html`<div class="state" role="status">${status}</div>` : nothing}
		</header>`;
	}
}
customElements.define("pi-header", PiHeader);
