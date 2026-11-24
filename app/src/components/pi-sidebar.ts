import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import { SEARCH_ICON, SETTINGS_ICON, X_ICON, SQUARE_PEN_ICON, sharedStyles } from "@thatsit/kit";
import type { SessionSummary, SessionType } from "../../../shared/src/protocol.ts";
import { filterByType, formatTokens, groupSessions, newSessionLabel, relativeTime, sessionTitle } from "../lib/format.ts";
import type { ListStore } from "../lib/list-store.ts";
import { hrefFor } from "../lib/route.ts";
import type { HubApi } from "../lib/api.ts";
import { SearchStore } from "../lib/search-store.ts";
import { searchHits, searchHitsStyles } from "../render/search-hits.ts";
import { sessionTypeToggle, sessionTypeToggleStyles } from "../render/session-type-toggle.ts";

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
	static properties = { list: { attribute: false }, currentId: { attribute: false }, query: { state: true }, searchOpen: { state: true }, api: { attribute: false }, type: { attribute: false } };
	declare list: ListStore | null;
	declare currentId: string | null;
	declare query: string;
	declare type: SessionType;
	declare searchOpen: boolean;
	declare api: Pick<HubApi, "search"> | null;
	private store: SearchStore | null = null;
	private storeApi: Pick<HubApi, "search"> | null = null;
	private bound: ListStore | null = null;

	static styles = [
		sharedStyles,
		sessionTypeToggleStyles,
		searchHitsStyles,
		css`
			:host { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; }
			/* min-height: the padding plus the brand's line box (the display font's normal line height, 39.66 px at 1.6rem;
			   layout floors to 1/64 px, hence 1.54908), so the search field's row is as tall as the row it replaces and the
			   list below does not move. Measured equal (65.66 px) on desktop and phone. */
			.top { display: flex; justify-content: space-between; align-items: center; padding: 16px 16px 10px; min-height: calc(26px + 1.6rem * 1.54908); }
			.brand { font-family: var(--font-display); font-size: 1.6rem; letter-spacing: 0.1em; color: var(--text-primary); }
			.top-start, .top-end { display: flex; align-items: center; gap: 12px; }
			.settings, .open-search { display: inline-flex; align-items: center; color: var(--text-secondary); }
			/* Michael's call: neither the search button nor the field ever shows a focus ring or a highlighted border. */
			.open-search:focus, .open-search:focus-visible { outline: none; box-shadow: none; }
			.search input:focus, .search input:focus-visible { outline: none; box-shadow: none; border-color: var(--line); }
			.settings:hover, .open-search:hover { color: var(--text-primary); }
			.settings svg, .open-search svg, .x svg { width: 18px; height: 18px; }
			.new-session { position: absolute; left: 12px; bottom: calc(12px + var(--safe-bottom)); width: 48px; height: 48px; padding: 0; border-radius: 50%; }
			.new-session svg { width: 24px; height: 24px; }
			.open-search { padding: 0; background: none; border: 0; cursor: pointer; }
			.top.searching { justify-content: flex-start; gap: 12px; }
			.search { flex: 1; min-width: 0; }
			.search input { width: 100%; border-color: var(--line); padding: 5px 9px; }
			/* The close button is the one ✕: no native clear button inside the field. */
			.search input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
			.x { display: inline-flex; align-items: center; padding: 0; background: none; border: 0; cursor: pointer; color: var(--text-secondary); }
			.x:hover { color: var(--text-primary); }
			.offline { margin: 4px 16px 8px; font-size: 0.8rem; color: var(--accent); }
			.retry { color: var(--primary); margin-left: 6px; }
			.groups { overflow-y: auto; flex: 1; padding-bottom: calc(72px + var(--safe-bottom)); overscroll-behavior: contain; }
			h2.label { margin: 0; padding: 12px 16px 4px; font-weight: 400; }
			.row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; column-gap: 8px; row-gap: 2px; align-items: baseline; padding: 7px 16px 7px 14px; border-left: 2px solid transparent; color: var(--text-primary); }
			.row:hover { background: var(--panel); }
			.row.cur { background: var(--panel); border-left-color: var(--primary); }
			.t { font-weight: 500; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.ago { font-size: 0.72rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
			.d { grid-column: 2 / 4; font-size: 0.72rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.none { padding: 16px; color: var(--text-secondary); font-size: 0.9rem; }
		`,
	];

	constructor() {
		super();
		this.list = null;
		this.currentId = null;
		this.query = "";
		this.type = "code";
		this.searchOpen = false;
		this.api = null;
	}

	private onChange = () => this.requestUpdate();

	private get search(): SearchStore | null {
		if (this.storeApi !== this.api) {
			this.store?.clear();
			this.store?.removeEventListener("change", this.onChange);
			this.store = this.api ? new SearchStore({ api: this.api }) : null;
			this.store?.addEventListener("change", this.onChange);
			this.storeApi = this.api;
		}
		return this.store;
	}

	private closeSearch = () => {
		this.searchOpen = false;
		this.query = "";
		this.search?.clear();
	};

	// Escape closes the field only: preventDefault tells the shell's drawer to stay open. Not mid-composition (IME).
	private onSearchKey = (e: KeyboardEvent) => {
		if (e.key !== "Escape" || e.isComposing) return;
		e.preventDefault();
		this.closeSearch();
	};

	updated(changed: PropertyValues<this>): void {
		if (!changed.has("searchOpen")) return;
		if (this.searchOpen) this.renderRoot.querySelector<HTMLInputElement>(".search input")?.focus();
		else if (changed.get("searchOpen") === true) this.renderRoot.querySelector<HTMLButtonElement>(".open-search")?.focus(); // focus goes back where it came from
	}

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
		this.store?.clear();
		this.store?.removeEventListener("change", this.onChange);
		this.store = null;
		this.storeApi = null;
		super.disconnectedCallback();
	}

	render() {
		const list = this.list;
		const groups = list ? groupSessions(filterByType(list.sessions, this.type), this.query, list.home) : [];
		return html`
			${this.searchOpen
				? html`<div class="top searching">
						<label class="search open">
							<span class="sr-only">Search sessions</span>
							<input type="search" placeholder="search sessions" .value=${this.query} @input=${this.onInput} @keydown=${this.onSearchKey} />
						</label>
						<button class="x" aria-label="close search" @click=${this.closeSearch}>${X_ICON}</button>
					</div>`
				: html`<div class="top">
						<span class="top-start"><a class="brand" href="#/" aria-label="pi home"><span class="u on">pi</span></a><button class="open-search" aria-label="search sessions" title="search sessions" @click=${() => (this.searchOpen = true)}>${SEARCH_ICON}</button></span>
						<span class="top-end">${sessionTypeToggle(this.type, (t) => this.dispatchEvent(new CustomEvent("pi-session-type", { detail: { type: t }, bubbles: true, composed: true })))}<a class="settings" href="#/settings" aria-label="settings" title="settings">${SETTINGS_ICON}</a></span>
					</div>`}
			${list?.error ? html`<div class="offline" role="status">${list.error}<button class="retry u" @click=${() => list.refresh()}>retry</button></div>` : nothing}
			<div class="groups">
				${groups.map((g) => html`<section><h2 class="label">${g.label}</h2>${g.sessions.map((s) => this.row(s))}</section>`)}
				${list?.loaded && groups.length === 0 ? html`<p class="none">${this.searchOpen && this.query ? "No session titles match." : `No ${this.type} sessions yet.`}</p>` : nothing}
				${list && this.searchOpen && this.search ? searchHits(this.search.state, list.home) : nothing}
			</div>
			<button class="btn new-session" aria-label=${newSessionLabel(this.type)} title=${newSessionLabel(this.type)} @click=${this.newSession}>${SQUARE_PEN_ICON}</button>
		`;
	}

	private onInput = (e: Event) => {
		this.query = (e.target as HTMLInputElement).value;
		this.search?.setQuery(this.query);
	};

	// The route may not change (already on a new chat), so the app closes a drawer explicitly (a docked panel stays).
	private newSession = () => {
		location.hash = hrefFor({ name: "new" });
		this.dispatchEvent(new CustomEvent("pi-new-session", { bubbles: true, composed: true }));
	};

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
