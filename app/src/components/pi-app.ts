import { LitElement, css, html } from "lit";
import { HubApi } from "../lib/api.ts";
import { ListStore } from "../lib/list-store.ts";
import { type Route, hrefFor, parseRoute } from "../lib/route.ts";
import { getHubUrl } from "../lib/settings.ts";
import { sharedStyles } from "../styles/shared.ts";
import "./pi-new-session.ts";
import "./pi-session.ts";
import "./pi-settings.ts";
import "./pi-sidebar.ts";
import "./pi-toasts.ts";

export class PiApp extends LitElement {
	static properties = { route: { state: true }, navOpen: { state: true }, api: { state: true }, list: { state: true } };
	declare route: Route;
	declare navOpen: boolean;
	declare api: HubApi | null;
	declare list: ListStore | null;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; height: 100%; }
			.layout { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); height: 100vh; height: 100dvh; }
			.sidebar { border-right: 1px solid var(--line); min-width: 0; min-height: 0; background: var(--bg); padding-top: env(safe-area-inset-top); }
			.main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
			.main > * { flex: 1; min-height: 0; }
			.overlay { display: none; }
			.empty { margin: auto; flex: none; text-align: center; padding: 24px; color: var(--text-2); }
			.empty h1 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.1em; font-size: 3rem; color: var(--text); margin: 0 0 10px; }
			.empty .menu { display: none; }
			@media (max-width: 899px) {
				.layout { grid-template-columns: minmax(0, 1fr); }
				.sidebar { position: fixed; inset: 0 auto 0 0; width: min(80vw, 360px); z-index: 20; transform: translateX(-100%); transition: transform 0.25s ease; box-shadow: 2px 0 12px rgba(0, 0, 0, 0.2); }
				.nav-open .sidebar { transform: none; }
				.overlay { display: block; position: fixed; inset: 0; background: var(--overlay); z-index: 10; opacity: 0; pointer-events: none; transition: opacity 0.25s; }
				.nav-open .overlay { opacity: 1; pointer-events: auto; }
				.empty .menu { display: inline-block; font-size: 1.4rem; margin-bottom: 12px; }
			}
		`,
	];

	constructor() {
		super();
		this.route = parseRoute(location.hash);
		this.navOpen = false;
		this.api = null;
		this.list = null;
	}

	private onHash = () => {
		this.route = parseRoute(location.hash);
		this.navOpen = false;
	};
	private onOpenNav = () => {
		this.navOpen = true;
	};
	private onRouteReplaced = (e: Event) => {
		this.route = (e as CustomEvent<Route>).detail;
	};

	connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener("hashchange", this.onHash);
		this.addEventListener("pi-open-nav", this.onOpenNav);
		this.addEventListener("pi-route-replaced", this.onRouteReplaced);
		this.connectHub();
	}

	disconnectedCallback(): void {
		window.removeEventListener("hashchange", this.onHash);
		this.removeEventListener("pi-open-nav", this.onOpenNav);
		this.removeEventListener("pi-route-replaced", this.onRouteReplaced);
		this.list?.stop();
		super.disconnectedCallback();
	}

	private connectHub = () => {
		this.list?.stop();
		const url = getHubUrl();
		if (!url) {
			this.api = null;
			this.list = null;
			if (this.route.name !== "settings") location.hash = hrefFor({ name: "settings" });
			return;
		}
		this.api = new HubApi(url);
		this.list = new ListStore(this.api);
		this.list.start();
	};

	render() {
		const r = this.route;
		return html`
			<div class="layout ${this.navOpen ? "nav-open" : ""}">
				<aside class="sidebar" aria-label="Sessions">
					<pi-sidebar .list=${this.list} .currentId=${r.name === "session" ? r.id : null}></pi-sidebar>
				</aside>
				<div class="overlay" @click=${() => (this.navOpen = false)}></div>
				<main class="main">${this.renderMain(r)}</main>
			</div>
			<pi-toasts></pi-toasts>
		`;
	}

	private renderMain(r: Route) {
		if (!this.api || r.name === "settings") return html`<pi-settings @pi-hub-changed=${this.connectHub}></pi-settings>`;
		if (r.name === "session") return html`<pi-session .api=${this.api} .sessionId=${r.id} .home=${this.list?.home ?? ""}></pi-session>`;
		if (r.name === "new") return html`<pi-new-session .api=${this.api} .cwd=${r.cwd ?? null}></pi-new-session>`;
		return html`<div class="empty">
			<button class="menu" aria-label="Open sessions" @click=${this.onOpenNav}>☰</button>
			<h1><span class="u on">pi</span></h1>
			<p>Pick a session, or <a class="u" href="#/new">start a new one</a>.</p>
		</div>`;
	}
}
customElements.define("pi-app", PiApp);
