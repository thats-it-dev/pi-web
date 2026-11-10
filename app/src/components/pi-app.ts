import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import { type Panel, type TkShell, sharedStyles } from "@thatsit/kit";
import { HubApi } from "../lib/api.ts";
import { launchRoute } from "../lib/launch.ts";
import { ListStore } from "../lib/list-store.ts";
import type { ProgressStore } from "../lib/progress-store.ts";
import { browserPushEnv, resyncPush } from "../lib/push.ts";
import { type Route, hrefFor, parseRoute } from "../lib/route.ts";
import { getHubUrl } from "../lib/settings.ts";
import "./pi-new-chat.ts";
import "./pi-progress-panel.ts";
import "./pi-session.ts";
import "./pi-settings.ts";
import "./pi-sidebar.ts";
import type { PiSession } from "./pi-session.ts";

export class PiApp extends LitElement {
	static properties = { route: { state: true }, api: { state: true }, list: { state: true }, progress: { state: true } };
	declare route: Route;
	declare api: HubApi | null;
	declare list: ListStore | null;
	declare progress: ProgressStore | null; // the open session's progress, shown in the shell's aside panel

	private popping = false; // the aside drawer is closing because of Back
	private replacing = false; // the aside drawer is closing because a subagent thread replaces its history entry

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
		this.progress = null;
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
		this.addEventListener("pi-progress", this.onProgress);
		this.addEventListener("tk-panel-change", this.onPanelChange);
		window.addEventListener("popstate", this.onPop);
		this.connectHub();
	}

	disconnectedCallback(): void {
		window.removeEventListener("hashchange", this.onHash);
		this.removeEventListener("pi-route-replaced", this.onRouteReplaced);
		this.removeEventListener("pi-progress", this.onProgress);
		this.removeEventListener("tk-panel-change", this.onPanelChange);
		window.removeEventListener("popstate", this.onPop);
		this.stopList();
		super.disconnectedCallback();
	}

	// A session leaving the page cannot report it (its event no longer reaches here), so off a session the panel goes.
	willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("route") && !isSession(this.route)) this.progress = null;
	}

	private onProgress = (e: Event) => {
		this.progress = (e as CustomEvent<{ store: ProgressStore | null }>).detail.store;
	};

	private shell(): TkShell | null {
		return this.renderRoot.querySelector("tk-shell");
	}

	private session(): PiSession | null {
		return this.renderRoot.querySelector("pi-session");
	}

	// The progress drawer sits on a history entry of its own, so Back closes it and leaves the chat where it is.
	private onPanelChange = (e: Event) => {
		const { panel, open, docked } = (e as CustomEvent<{ panel: Panel; open: boolean; docked: boolean }>).detail;
		if (panel !== "aside" || docked) return;
		if (open) {
			history.pushState({ piProgress: true }, "");
			return;
		}
		const popping = this.popping;
		this.popping = false;
		if (history.state?.piProgress && !popping && !this.replacing) history.back();
	};

	private onPop = () => {
		const shell = this.shell();
		if (!shell?.asideOpen) return;
		this.popping = true;
		shell.hide("aside");
	};

	// From the drawer, the thread takes over the drawer's history entry: Back from it lands on the parent chat.
	private onOpenChild = (e: Event) => {
		const key = (e as CustomEvent<string>).detail;
		const shell = this.shell();
		const r = this.route;
		if (!shell?.asideOpen || !history.state?.piProgress || !isSession(r)) {
			if (shell?.asideOpen) shell.hide("aside");
			this.session()?.openChild(key);
			return;
		}
		this.replacing = true;
		shell.hide("aside");
		location.replace(hrefFor({ name: "subagent", id: r.id, key }));
		// tk-panel-change comes from the shell's next update: keep the flag till then.
		void shell.updateComplete.then(() => (this.replacing = false));
	};

	private onOpenPlan = () => this.session()?.openPlan();

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
		const childKey = r.name === "subagent" ? r.key : null;
		return html`
			<tk-shell nav-label="Sessions" aside-label="Progress" store-key="pi-web:panels">
				<pi-sidebar slot="nav" .list=${this.list} .currentId=${isSession(r) ? r.id : null}></pi-sidebar>
				${this.progress
					? html`<pi-progress-panel slot="aside" .store=${this.progress} .selectedKey=${childKey} @pi-open-child=${this.onOpenChild} @pi-open-plan=${this.onOpenPlan}></pi-progress-panel>`
					: nothing}
				${this.renderMain(r)}
			</tk-shell>
			<tk-toasts></tk-toasts>
		`;
	}

	private renderMain(r: Route) {
		if (!this.api || r.name === "settings") return html`<pi-settings @pi-hub-changed=${this.connectHub}></pi-settings>`;
		// A subagent route is the same pi-session element: only childKey changes, so the parent's stream stays open.
		if (r.name === "session" || r.name === "subagent")
			return html`<pi-session .api=${this.api} .list=${this.list} .sessionId=${r.id} .childKey=${r.name === "subagent" ? r.key : null} .home=${this.list?.home ?? ""}></pi-session>`;
		if (r.name === "new") return html`<pi-new-chat .api=${this.api} .home=${this.list?.home ?? ""}></pi-new-chat>`;
		// home: launch() picks the route once the sessions are in; till then, a way to the sessions.
		return html`<div class="waiting"><button class="menu" aria-label="Open sessions" @click=${this.openNav}>☰</button></div>`;
	}
}
customElements.define("pi-app", PiApp);

function isSession(r: Route): r is Extract<Route, { name: "session" | "subagent" }> {
	return r.name === "session" || r.name === "subagent";
}
