import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import { ARROW_LEFT_ICON, type Panel, type TkShell, sharedStyles } from "@thatsit/kit";
import type { PreviewKind, PreviewState } from "../../../shared/src/preview.ts";
import { HubApi } from "../lib/api.ts";
import { type AsideTab, nextTab, shellAttrs, shownPreview, snapSize } from "../lib/aside-state.ts";
import { launchRoute } from "../lib/launch.ts";
import { ListStore } from "../lib/list-store.ts";
import { type AsideSize, PHONE_MAX_W, type PreviewMode, TABLET_MAX_W, readTab } from "../lib/preview-ui.ts";
import type { ProgressStore } from "../lib/progress-store.ts";
import { browserPushEnv, resyncPush } from "../lib/push.ts";
import { type Route, hrefFor, parseRoute } from "../lib/route.ts";
import { getHubUrl } from "../lib/settings.ts";
import "./pi-aside.ts";
import "./pi-new-chat.ts";
import "./pi-session.ts";
import "./pi-settings.ts";
import "./pi-sidebar.ts";
import type { PiSession } from "./pi-session.ts";

// Above the class: customElements.define below constructs <pi-app> at once if it is already in the page.
const TAB_KEY = "pi-web:aside-tab";
const FRESH_MS = 60_000; // a preview this new was just opened by pi, not restored from history

export class PiApp extends LitElement {
	static properties = {
		route: { state: true },
		api: { state: true },
		list: { state: true },
		progress: { state: true },
		preview: { state: true },
		pages: { state: true },
		tab: { state: true },
		size: { state: true },
		mode: { state: true },
		finePointer: { state: true },
	};
	declare route: Route;
	declare api: HubApi | null;
	declare list: ListStore | null;
	declare progress: ProgressStore | null; // the open session's progress, shown in the shell's aside panel
	declare preview: PreviewState | null; // the open session's preview, derived from its conversation
	declare pages: PreviewState | null; // a Pages link opened from the Progress tab, shown over an older preview
	declare tab: AsideTab; // the aside tab last picked, kept per device
	declare size: AsideSize; // the Preview tab's requested size (the Progress tab always has the default)
	declare mode: PreviewMode;
	declare finePointer: boolean;

	private lastSeenAt = 0; // the newest derived preview already switched to, so it switches once
	private previewOf: string | null = null; // the session the preview state belongs to
	private phoneMq = matchMedia(`(max-width: ${PHONE_MAX_W}px)`);
	private tabletMq = matchMedia(`(max-width: ${TABLET_MAX_W}px)`);
	private fineMq = matchMedia("(pointer: fine)");

	private popping = false; // the aside drawer is closing because of Back
	private replacing = false; // the aside drawer is closing because a subagent thread replaces its history entry

	static styles = [
		sharedStyles,
		css`
			:host { display: block; height: 100%; }
			.waiting { margin: auto; flex: none; padding: 24px; }
			.waiting .menu { display: none; font-size: 1.4rem; }
			/* Preview at full size: the shell leaves the main column a 48px strip, with a way back to the chat. */
			.strip { display: none; }
			tk-shell[aside-full] pi-session { display: none; }
			tk-shell[aside-full] .strip { display: flex; flex-direction: column; align-items: center; padding-top: calc(8px + env(safe-area-inset-top)); }
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
		this.preview = null;
		this.pages = null;
		this.tab = readTab(readStored(TAB_KEY));
		this.size = "default";
		this.mode = this.computeMode();
		this.finePointer = this.fineMq.matches;
	}

	private computeMode(): PreviewMode {
		return this.phoneMq.matches ? "card" : this.tabletMq.matches ? "fullscreen" : "panel";
	}
	private onMedia = () => {
		this.mode = this.computeMode();
		this.finePointer = this.fineMq.matches;
	};

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
		this.addEventListener("tk-aside-resize", this.onAsideResize);
		this.addEventListener("pi-preview", this.onPreview);
		this.addEventListener("pi-open-preview", this.onOpenPreview);
		for (const mq of [this.phoneMq, this.tabletMq, this.fineMq]) mq.addEventListener("change", this.onMedia);
		window.addEventListener("popstate", this.onPop);
		this.onMedia();
		this.connectHub();
	}

	disconnectedCallback(): void {
		window.removeEventListener("hashchange", this.onHash);
		this.removeEventListener("pi-route-replaced", this.onRouteReplaced);
		this.removeEventListener("pi-progress", this.onProgress);
		this.removeEventListener("tk-panel-change", this.onPanelChange);
		this.removeEventListener("tk-aside-resize", this.onAsideResize);
		this.removeEventListener("pi-preview", this.onPreview);
		this.removeEventListener("pi-open-preview", this.onOpenPreview);
		for (const mq of [this.phoneMq, this.tabletMq, this.fineMq]) mq.removeEventListener("change", this.onMedia);
		window.removeEventListener("popstate", this.onPop);
		this.stopList();
		super.disconnectedCallback();
	}

	// A session leaving the page cannot report it (its event no longer reaches here), so off a session the panel goes.
	// Another session (or none) starts the preview state afresh: its own preview, no Pages link, nothing seen yet.
	willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("route") && !isSession(this.route)) this.progress = null;
		const id = isSession(this.route) ? this.route.id : null;
		if (id !== this.previewOf) {
			this.previewOf = id;
			if (!id) this.preview = null;
			this.pages = null;
			this.lastSeenAt = 0;
		}
		if (changed.has("tab")) writeStored(TAB_KEY, this.tab);
	}

	// A preview pi opened (newer than any already switched to) brings up the Preview tab, and the aside when it is
	// fresh. One restored from history only picks the tab: reopening a chat doesn't throw a drawer over it.
	private onPreview = (e: Event) => {
		const preview = (e as CustomEvent<{ preview: PreviewState | null }>).detail.preview;
		this.preview = preview;
		if (!preview || preview.at <= this.lastSeenAt) return;
		if (nextTab(this.asideInput()) === "preview") {
			this.tab = "preview";
			if (Date.now() - preview.at < FRESH_MS) void this.showAside();
		}
		this.lastSeenAt = preview.at;
	};

	// From a card in the reply or a Pages link in the Progress tab. On a phone the card's own link opens the page.
	private onOpenPreview = (e: Event) => {
		const d = (e as CustomEvent<{ url: string; label: string; kind: PreviewKind }>).detail;
		// A card for a preview that is no longer live has nothing to show here: its link opens the url instead.
		if (d.kind !== "pages" && this.preview?.url !== d.url) return;
		e.preventDefault();
		if (d.kind === "pages") this.pages = { url: d.url, label: d.label, kind: "pages", at: Date.now() };
		this.tab = "preview";
		if (this.mode !== "card" || d.kind === "pages") void this.showAside();
	};

	private onAsideTab = (e: Event) => {
		this.tab = (e as CustomEvent<{ tab: AsideTab }>).detail.tab;
		// Between 900 and 1199px the tab decides docked or drawer: keep the aside in view either way.
		void this.showAside();
	};

	private onSnap = () => {
		this.size = snapSize(this.size, window.innerWidth);
		if (this.size === "default") this.shell()?.resetAsideWidth();
	};

	private onPreviewBack = () => this.shell()?.hide("aside");

	private onPreviewClose = () => {
		this.pages = null;
		this.tab = "progress";
		if (!this.progress) this.shell()?.hide("aside");
	};

	// A drag sets its own width, so the requested size is back to default (the shell has reset its own already).
	private onAsideResize = () => {
		this.size = "default";
	};

	// Once this render has the aside (it may have only just appeared) and the shell has taken the new attributes.
	private async showAside(): Promise<void> {
		await this.updateComplete;
		const shell = this.shell();
		if (!shell) return;
		await shell.updateComplete;
		shell.show("aside");
	}

	private asideInput() {
		return { derived: this.preview, pages: this.pages, tab: this.tab, hasProgress: this.progress !== null, width: window.innerWidth, lastSeenAt: this.lastSeenAt };
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
		if (panel !== "aside") return;
		// The open drawer docked (the Preview tab docks from 900px up, or the window widened): its history entry goes.
		if (docked) {
			if (open && history.state?.piProgress) history.back(); // onPop finds no drawer open and leaves it
			return;
		}
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
		const input = this.asideInput();
		const shown = shownPreview(input);
		const tab = nextTab(input);
		const a = shellAttrs({ tab, preview: shown, mode: this.mode, finePointer: this.finePointer, size: this.size });
		return html`
			<tk-shell
				nav-label="Sessions"
				aside-label="Progress"
				store-key="pi-web:panels"
				?resizable=${a.resizable}
				?dock-aside=${a.dockAside}
				?aside-fullscreen=${a.asideFullscreen}
				aside-size=${a.asideSize}
			>
				<pi-sidebar slot="nav" .list=${this.list} .currentId=${isSession(r) ? r.id : null}></pi-sidebar>
				${this.progress || shown
					? html`<pi-aside
							slot="aside"
							.progress=${this.progress}
							.preview=${shown}
							.tab=${tab}
							.mode=${this.mode}
							.size=${this.size}
							.selectedKey=${childKey}
							@pi-open-child=${this.onOpenChild}
							@pi-open-plan=${this.onOpenPlan}
							@pi-aside-tab=${this.onAsideTab}
							@pi-preview-snap=${this.onSnap}
							@pi-preview-back=${this.onPreviewBack}
							@pi-preview-close=${this.onPreviewClose}
						></pi-aside>`
					: nothing}
				${this.renderMain(r)}
				<div class="strip"><button class="icon-btn" aria-label="Back to chat" @click=${() => (this.size = "half")}>${ARROW_LEFT_ICON}</button></div>
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

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// storage unavailable: the tab still applies for this page
	}
}

function isSession(r: Route): r is Extract<Route, { name: "session" | "subagent" }> {
	return r.name === "session" || r.name === "subagent";
}
