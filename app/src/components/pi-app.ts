import { LitElement, css, html } from "lit";
import { sharedStyles } from "@thatsit/kit";
import { HubApi } from "../lib/api.ts";
import { launchRoute } from "../lib/launch.ts";
import { ListStore } from "../lib/list-store.ts";
import { browserPushEnv, resyncPush } from "../lib/push.ts";
import { type Route, hrefFor, parseRoute } from "../lib/route.ts";
import { getHubUrl } from "../lib/settings.ts";
import "./pi-new-chat.ts";
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
			.waiting { margin: auto; flex: none; padding: 24px; }
			.waiting .menu { display: none; font-size: 1.4rem; }
			@media (max-width: 899px) {
				.waiting .menu { display: inline-block; }
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
		this.launch();
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
		this.stopList();
		super.disconnectedCallback();
	}

	// No route in the URL: open a recent chat, or a new one, once the hub's list is in (not the cached one).
	private launch = () => {
		const list = this.list;
		if (this.route.name !== "home" || !list?.loaded) return;
		const r = launchRoute(list.sessions, Date.now());
		history.replaceState(null, "", hrefFor(r));
		this.route = r;
	};

	private stopList(): void {
		this.list?.removeEventListener("change", this.launch);
		this.list?.stop();
	}

	private connectHub = () => {
		this.stopList();
		const url = getHubUrl();
		if (!url) {
			this.api = null;
			this.list = null;
			if (this.route.name !== "settings") location.hash = hrefFor({ name: "settings" });
			return;
		}
		this.api = new HubApi(url);
		this.list = new ListStore(this.api);
		this.list.addEventListener("change", this.launch);
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
		if (r.name === "session") return html`<pi-session .api=${this.api} .list=${this.list} .sessionId=${r.id} .home=${this.list?.home ?? ""}></pi-session>`;
		if (r.name === "new") return html`<pi-new-chat .api=${this.api} .home=${this.list?.home ?? ""}></pi-new-chat>`;
		// home: launch() picks the route once the sessions are in; till then, a way to the sessions.
		return html`<div class="waiting"><button class="menu" aria-label="Open sessions" @click=${this.openNav}>☰</button></div>`;
	}
}
customElements.define("pi-app", PiApp);
