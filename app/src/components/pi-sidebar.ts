import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import type { SessionSummary } from "../../../shared/src/protocol.ts";
import { formatTokens, groupSessions, relativeTime, sessionTitle } from "../lib/format.ts";
import type { ListStore } from "../lib/list-store.ts";
import { hrefFor } from "../lib/route.ts";
import { sharedStyles } from "../styles/shared.ts";

function stateLabel(s: SessionSummary): string | null {
	if (s.state === "running") return "running";
	if (s.state === "needs_you") return "needs you";
	if (s.state === "error") return "stopped with an error";
	if (s.live) return s.handleKind === "bridge" ? "open in terminal" : "open";
	return null;
}

function dotClass(s: SessionSummary): string {
	if (s.state === "running" || s.state === "needs_you" || s.state === "error") return s.state;
	return s.live ? "live" : "";
}

export class PiSidebar extends LitElement {
	static properties = { list: { attribute: false }, currentId: { attribute: false }, query: { state: true } };
	declare list: ListStore | null;
	declare currentId: string | null;
	declare query: string;
	private bound: ListStore | null = null;

	static styles = [
		sharedStyles,
		css`
			:host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
			.top { display: flex; justify-content: space-between; align-items: baseline; padding: 16px 16px 10px; }
			.brand { font-family: var(--font-display); font-size: 1.6rem; letter-spacing: 0.1em; color: var(--text); }
			nav { display: flex; gap: 14px; font-family: var(--font-quote); font-weight: 500; font-size: 0.9rem; }
			.search { padding: 0 16px 8px; }
			.search input { width: 100%; border-color: var(--line); padding: 5px 9px; }
			.offline { margin: 4px 16px 8px; font-size: 0.8rem; color: var(--primary); }
			.retry { color: var(--accent); margin-left: 6px; }
			.groups { overflow-y: auto; flex: 1; padding-bottom: calc(16px + var(--safe-bottom)); overscroll-behavior: contain; }
			h2.label { margin: 0; padding: 12px 16px 4px; font-weight: 400; }
			.row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; column-gap: 8px; row-gap: 2px; align-items: baseline; padding: 7px 16px 7px 14px; border-left: 2px solid transparent; color: var(--text); }
			.row:hover { background: var(--panel); }
			.row.cur { background: var(--panel); border-left-color: var(--accent); }
			.t { font-weight: 500; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.ago { font-size: 0.72rem; color: var(--muted); font-variant-numeric: tabular-nums; }
			.d { grid-column: 2 / 4; font-size: 0.72rem; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.none { padding: 16px; color: var(--text-2); font-size: 0.9rem; }
		`,
	];

	constructor() {
		super();
		this.list = null;
		this.currentId = null;
		this.query = "";
	}

	private onChange = () => this.requestUpdate();

	willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("list") && this.bound !== this.list) {
			this.bound?.removeEventListener("change", this.onChange);
			this.bound = this.list;
			this.bound?.addEventListener("change", this.onChange);
		}
	}

	disconnectedCallback(): void {
		this.bound?.removeEventListener("change", this.onChange);
		this.bound = null;
		super.disconnectedCallback();
	}

	render() {
		const list = this.list;
		const groups = list ? groupSessions(list.sessions, this.query, list.home) : [];
		return html`
			<div class="top">
				<a class="brand" href="#/" aria-label="pi home"><span class="u on">pi</span></a>
				<nav><a class="u" href="#/new">+ new</a><a class="u" href="#/settings">settings</a></nav>
			</div>
			<label class="search">
				<span class="sr-only">Search sessions</span>
				<input type="search" placeholder="search sessions" .value=${this.query} @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)} />
			</label>
			${list?.error ? html`<div class="offline" role="status">${list.error}<button class="retry u" @click=${() => list.refresh()}>retry</button></div>` : nothing}
			<div class="groups">
				${groups.map((g) => html`<section><h2 class="label">${g.label}</h2>${g.sessions.map((s) => this.row(s))}</section>`)}
				${list?.loaded && groups.length === 0 ? html`<p class="none">${this.query ? "No sessions match." : html`No sessions yet. <a href="#/new">Start one</a>.`}</p>` : nothing}
			</div>
		`;
	}

	private row(s: SessionSummary) {
		const cur = s.id === this.currentId;
		const model = s.model?.split("/").pop() ?? null;
		const meta = [stateLabel(s), model, s.contextTokens != null ? `${formatTokens(s.contextTokens)} context` : null].filter(Boolean).join(" · ");
		return html`<a class="row ${cur ? "cur" : ""}" href=${hrefFor({ name: "session", id: s.id })} aria-current=${cur ? "page" : "false"}>
			<span class="dot ${dotClass(s)}" aria-hidden="true"></span>
			<span class="t">${sessionTitle(s)}</span>
			<span class="ago">${relativeTime(s.updatedAt)}</span>
			<span class="d">${meta || `${s.userMessages} prompt${s.userMessages === 1 ? "" : "s"}`}</span>
		</a>`;
	}
}
customElements.define("pi-sidebar", PiSidebar);
