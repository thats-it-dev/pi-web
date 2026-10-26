import { LitElement, css, html } from "lit";
import { sharedStyles } from "@thatsit/kit";
import { HubApi } from "../lib/api.ts";
import { ListStore } from "../lib/list-store.ts";
import { browserPushEnv, resyncPush } from "../lib/push.ts";
import { type Route, hrefFor, parseRoute } from "../lib/route.ts";
import { getHubUrl } from "../lib/settings.ts";
import "./pi-new-session.ts";
import "./pi-session.ts";
import "./pi-settings.ts";
import "./pi-sidebar.ts";

export class PiApp extends LitElement {
	static properties = { route: { state: true }, api: { state: true }, list: { state: true } };
	declare route: Route;
	declare api: HubApi | null;
	declare list: ListStore | null;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; height: 100%; }
			.empty { margin: auto; flex: none; text-align: center; padding: 24px; color: var(--text-secondary); }
			.empty h1 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.1em; font-size: 3rem; color: var(--text-primary); margin: 0 0 10px; }
			.empty .menu { display: none; }
			@media (max-width: 899px) {
				.empty .menu { display: inline-block; font-size: 1.4rem; margin-bottom: 12px; }
			}
		`,
	];

	constructor() {
		super();
		this.route = parseRoute(location.hash);
		this.api = null;
		this.list = null;
	}

	private onHash = () => {
		this.route = parseRoute(location.hash);
	};
	private onRouteReplaced = (e: Event) => {
		this.route = (e as CustomEvent<Route>).detail;
	};

	connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener("hashchange", this.onHash);
		this.addEventListener("pi-route-replaced", this.onRouteReplaced);
		this.connectHub();
	}

	disconnectedCallback(): void {
		window.removeEventListener("hashchange", this.onHash);
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
		void resyncPush(this.api, browserPushEnv());
	};

	// Sent from the button, not this host: tk-shell sits inside pi-app and only hears events from its own children.
	private openNav = (e: Event) => {
		e.currentTarget?.dispatchEvent(new CustomEvent("tk-open-nav", { bubbles: true, composed: true }));
	};

	render() {
		const r = this.route;
		return html`
			<tk-shell nav-label="Sessions">
				<pi-sidebar slot="nav" .list=${this.list} .currentId=${r.name === "session" ? r.id : null}></pi-sidebar>
				${this.renderMain(r)}
			</tk-shell>
			<tk-toasts></tk-toasts>
		`;
	}

	private renderMain(r: Route) {
		if (!this.api || r.name === "settings") return html`<pi-settings @pi-hub-changed=${this.connectHub}></pi-settings>`;
		if (r.name === "session") return html`<pi-session .api=${this.api} .sessionId=${r.id} .home=${this.list?.home ?? ""}></pi-session>`;
		if (r.name === "new") return html`<pi-new-session .api=${this.api}></pi-new-session>`;
		return html`<div class="empty">
			<button class="menu" aria-label="Open sessions" @click=${this.openNav}>☰</button>
			<h1><span class="u on">pi</span></h1>
			<p>Pick a session, or <a class="u" href="#/new">start a new one</a>.</p>
		</div>`;
	}
}
customElements.define("pi-app", PiApp);
