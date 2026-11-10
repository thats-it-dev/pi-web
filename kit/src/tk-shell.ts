import { LitElement, css, html, nothing } from "lit";
import type { TkHeader } from "./tk-header.ts";
import { sharedStyles } from "./styles.ts";
import { type Hidden, type Mode, type Panel, type PanelsState, PHONE_MAX, WIDE_MIN, panelsState, readHidden, writeHidden } from "./panels.ts";

const PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`;
const WIDE_QUERY = `(min-width: ${WIDE_MIN}px)`;
const PANELS: Panel[] = ["nav", "aside"];

// App layout: nav slot in a left panel, aside slot in a right panel, default slot as the main area.
// Docked panels are columns the user can hide; undocked ones are drawers that slide over the page.
export class TkShell extends LitElement {
	static properties = {
		navOpen: { type: Boolean, attribute: false },
		asideOpen: { type: Boolean, attribute: false },
		navLabel: { attribute: "nav-label" },
		asideLabel: { attribute: "aside-label" },
		storeKey: { attribute: "store-key" },
		navHidden: { type: Boolean, attribute: "nav-hidden", reflect: true },
		asideHidden: { type: Boolean, attribute: "aside-hidden", reflect: true },
		mode: { state: true },
		present: { state: true },
		sheets: { state: true },
	};
	declare navOpen: boolean;
	declare asideOpen: boolean;
	declare navLabel: string;
	declare asideLabel: string;
	declare storeKey: string | null;
	declare navHidden: boolean;
	declare asideHidden: boolean;
	declare private mode: Mode;
	declare private present: Record<Panel, boolean>;
	// Number of open tk-sheets, from tk-sheet-toggle on document.
	declare private sheets: number;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; height: 100%; position: relative; }
			[hidden] { display: none !important; }
			/* Home-screen app: a line under the system status bar, so the panels' side borders meet
			   something at the top instead of stopping in mid-air. Above headers, below drawers and the dim. */
			@media (display-mode: standalone) {
				:host::before { content: ""; position: absolute; left: 0; right: 0; top: env(safe-area-inset-top); height: 1px; background: var(--line); z-index: 6; pointer-events: none; }
			}
			/* Fixed tracks, so a hidden (absent) panel never shifts the main area into its column. */
			.layout { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr) var(--aside-w); height: 100%; transition: grid-template-columns 0.25s ease; }
			.layout.nav-closed { grid-template-columns: 0 minmax(0, 1fr) var(--aside-w); }
			.layout.aside-closed { grid-template-columns: var(--sidebar-w) minmax(0, 1fr) 0; }
			.layout.nav-closed.aside-closed { grid-template-columns: 0 minmax(0, 1fr) 0; }
			.sidebar { grid-area: 1 / 1; border-right: 1px solid var(--line); min-width: 0; min-height: 0; overflow: hidden; background: var(--bg); padding-top: env(safe-area-inset-top); }
			.details { grid-area: 1 / 3; border-left: 1px solid var(--line); min-width: 0; min-height: 0; overflow: hidden; background: var(--bg); padding-top: env(safe-area-inset-top); }
			/* a collapsed column keeps no border, or it would stick out of its 0-wide track; drawers keep theirs */
			.nav-closed .sidebar:not(.drawer), .aside-closed .details:not(.drawer) { border-width: 0; }
			.main { grid-area: 1 / 2; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
			/* the slot is display: contents, so the app's own children are what flex */
			::slotted(:not([slot])) { flex: 1; min-height: 0; }
			/* a header placed beside the page content keeps its own height; the content takes the rest */
			::slotted(tk-header:not([slot])) { flex: none; }
			/* Closed drawers stay off-screen and turn invisible once the slide ends. */
			.drawer { position: fixed; top: 0; bottom: 0; width: min(85vw, 360px); z-index: 20; visibility: hidden; transition: transform 0.25s ease, visibility 0s linear 0.25s; }
			.sidebar.drawer { left: 0; transform: translateX(-100%); box-shadow: 2px 0 12px var(--shadow-color); }
			.details.drawer { right: 0; transform: translateX(100%); box-shadow: -2px 0 12px var(--shadow-color); }
			/* the drawer itself takes focus only as a fallback target; its content shows the focus */
			.drawer:focus { outline: none; }
			.drawer.open { transform: none; visibility: visible; transition: transform 0.25s ease, visibility 0s; }
			.overlay { position: fixed; inset: 0; background: var(--overlay); z-index: 10; opacity: 0; visibility: hidden; transition: opacity 0.25s ease, visibility 0s linear 0.25s; }
			.drawer-open .overlay { opacity: 1; visibility: visible; transition: opacity 0.25s ease, visibility 0s; }
		`,
	];

	private phoneMq = matchMedia(PHONE_QUERY);
	private wideMq = matchMedia(WIDE_QUERY);
	// Last state announced through tk-panel-change; null until the first render.
	private lastState: PanelsState | null = null;
	// Open sheets reported through tk-sheet-toggle; disconnected ones stop counting.
	private openSheets = new Set<EventTarget>();
	// Focused element when a drawer opened, to return focus there when it closes.
	private opener: Element | null = null;
	// Headers inside this shell, kept current with the panel state for their buttons.
	private headers = new Set<TkHeader>();

	constructor() {
		super();
		this.navOpen = false;
		this.asideOpen = false;
		this.navLabel = "Navigation";
		this.asideLabel = "Details";
		this.storeKey = null;
		this.navHidden = false;
		this.asideHidden = false;
		this.mode = this.computeMode();
		this.present = { nav: false, aside: false };
		this.sheets = 0;
		// Added here, not in connectedCallback, so a header connecting in the same upgrade pass is never missed.
		this.addEventListener("tk-open-nav", () => this.show("nav"));
		this.addEventListener("tk-toggle-panel", (e) => this.withPanel(e, (p) => this.toggle(p)));
		this.addEventListener("tk-show-panel", (e) => this.withPanel(e, (p) => this.show(p)));
		this.addEventListener("tk-header-connect", (e) => {
			const header = (e as CustomEvent<{ header?: TkHeader }>).detail?.header;
			if (!header) return;
			this.headers.add(header);
			header.panels = this.state;
		});
		this.addEventListener("tk-hide-panel", (e) => this.withPanel(e, (p) => this.hide(p)));
	}

	private computeMode(): Mode {
		return this.phoneMq.matches ? "phone" : this.wideMq.matches ? "wide" : "mid";
	}

	private onMode = () => {
		this.mode = this.computeMode();
	};
	private withPanel(e: Event, fn: (p: Panel) => void): void {
		const p = panelOf(e);
		if (p) fn(p);
	}
	// Only the nav drawer closes on navigation; details belongs to the page and stays.
	private onHash = () => {
		this.navOpen = false;
	};
	private onSheet = (e: Event) => {
		const sheet = e.composedPath()[0];
		if ((e as CustomEvent<{ open?: unknown }>).detail?.open) this.openSheets.add(sheet);
		else this.openSheets.delete(sheet);
		// A removed sheet reports from document: the recount drops it as disconnected.
		this.countSheets();
	};
	private countSheets(): void {
		for (const s of this.openSheets) if (!(s as Node).isConnected) this.openSheets.delete(s);
		this.sheets = this.openSheets.size;
	}
	// Escape closes the open drawer, unless a sheet was open when the key went down: that sheet takes it.
	// The check runs in the capture phase because a sheet closing on the same key can re-render and
	// report itself closed between bubble listeners (microtasks run after each listener of a native event).
	private sheetOnKey = false;
	private onKeyCapture = (e: KeyboardEvent) => {
		if (e.key !== "Escape") return;
		this.countSheets();
		this.sheetOnKey = this.sheets > 0;
	};
	// An Escape the page already handled (its own popup, an IME composition) is not for the drawer.
	private onKey = (e: KeyboardEvent) => {
		if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || !this.drawer || this.sheetOnKey) return;
		this.navOpen = false;
		this.asideOpen = false;
	};
	private closeDrawer = () => {
		this.navOpen = false;
		this.asideOpen = false;
	};
	// Following a link closes the drawer. hashchange covers most links, but
	// tapping the current page's link changes nothing, so catch the click.
	private onSidebarClick = (e: Event) => {
		if (e.composedPath().some((el) => el instanceof HTMLAnchorElement)) this.navOpen = false;
	};
	private onSlot = (panel: Panel) => (e: Event) => {
		this.present = { ...this.present, [panel]: (e.target as HTMLSlotElement).assignedElements().length > 0 };
	};

	connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener("hashchange", this.onHash);
		document.addEventListener("tk-sheet-toggle", this.onSheet);
		window.addEventListener("keydown", this.onKeyCapture, true);
		document.addEventListener("keydown", this.onKey);
		// Sheets already open (open is reflected) before this shell connected; nothing tracked earlier carries over.
		this.openSheets.clear();
		for (const sh of document.querySelectorAll("tk-sheet[open]")) this.openSheets.add(sh);
		this.countSheets();
		this.phoneMq.addEventListener("change", this.onMode);
		this.wideMq.addEventListener("change", this.onMode);
		this.mode = this.computeMode();
		// Children are parsed by now, so presence is right on first render; slotchange keeps it current.
		this.present = {
			nav: !!this.querySelector(":scope > [slot=nav]"),
			aside: !!this.querySelector(":scope > [slot=aside]"),
		};
		let raw: string | null = null;
		try {
			if (this.storeKey) raw = localStorage.getItem(this.storeKey);
		} catch {
			// storage unavailable: use the attributes
		}
		const h = readHidden(raw, { nav: this.navHidden, aside: this.asideHidden });
		this.navHidden = h.nav;
		this.asideHidden = h.aside;
		// Headers parsed before this element upgraded announced themselves to no one; pick them up here.
		for (const header of this.querySelectorAll<TkHeader>("tk-header")) {
			this.headers.add(header);
			header.panels = this.state;
		}
	}

	disconnectedCallback(): void {
		window.removeEventListener("hashchange", this.onHash);
		document.removeEventListener("tk-sheet-toggle", this.onSheet);
		window.removeEventListener("keydown", this.onKeyCapture, true);
		document.removeEventListener("keydown", this.onKey);
		this.phoneMq.removeEventListener("change", this.onMode);
		this.wideMq.removeEventListener("change", this.onMode);
		super.disconnectedCallback();
	}

	private get hiddenFlags(): Hidden {
		return { nav: this.navHidden, aside: this.asideHidden };
	}

	private get drawer(): Panel | null {
		return this.navOpen ? "nav" : this.asideOpen ? "aside" : null;
	}

	private get state(): PanelsState {
		return panelsState({ mode: this.mode, present: this.present, hidden: this.hiddenFlags, drawer: this.drawer });
	}

	private setHidden(panel: Panel, value: boolean): void {
		if (panel === "nav") this.navHidden = value;
		else this.asideHidden = value;
		if (!this.storeKey) return;
		try {
			localStorage.setItem(this.storeKey, writeHidden(this.hiddenFlags));
		} catch {
			// storage unavailable or full: the state still applies for this page
		}
	}

	private setDrawer(panel: Panel, value: boolean): void {
		if (value) {
			this.navOpen = panel === "nav";
			this.asideOpen = panel === "aside";
		} else if (panel === "nav") this.navOpen = false;
		else this.asideOpen = false;
	}

	private set(panel: Panel, open: boolean): void {
		if (!this.state[panel].present) return;
		if (this.state[panel].docked) this.setHidden(panel, !open);
		else this.setDrawer(panel, open);
	}

	show(panel: Panel): void {
		this.set(panel, true);
	}
	hide(panel: Panel): void {
		this.set(panel, false);
	}
	toggle(panel: Panel): void {
		this.set(panel, !this.state[panel].open);
	}

	protected willUpdate(changed: Map<PropertyKey, unknown>): void {
		// Opening one drawer closes the other, however it was opened (methods or the properties).
		const wasNav = changed.has("navOpen") ? !!changed.get("navOpen") : this.navOpen;
		const wasAside = changed.has("asideOpen") ? !!changed.get("asideOpen") : this.asideOpen;
		const opensNav = this.navOpen && !wasNav;
		const opensAside = this.asideOpen && !wasAside;
		if (opensNav) this.asideOpen = false;
		else if (opensAside) this.navOpen = false;
		if (opensNav || opensAside) {
			// Switching drawers keeps the first opener: focus then sits in the drawer being replaced.
			if (!wasNav && !wasAside) this.opener = deepActiveElement();
			// Sheets removed from the page while open never report closing; drop them before deciding what goes inert.
			this.countSheets();
		}
		// A drawer whose panel docks (window widened) or disappears is no longer a drawer.
		const s = this.state;
		if (this.navOpen && (s.nav.docked || !s.nav.present)) this.navOpen = false;
		if (this.asideOpen && (s.aside.docked || !s.aside.present)) this.asideOpen = false;
	}

	protected updated(): void {
		const now = this.state;
		const prev = this.lastState;
		this.lastState = now;
		this.pushPanels(now);
		if (!prev) return;
		for (const p of PANELS) {
			if (prev[p].open === now[p].open && prev[p].docked === now[p].docked) continue;
			this.dispatchEvent(new CustomEvent("tk-panel-change", { detail: { panel: p, open: now[p].open, docked: now[p].docked }, bubbles: true, composed: true }));
		}
		const was = drawerOf(prev);
		const is = drawerOf(now);
		if (is && is !== was) this.focusInto(is);
		else if (was && !is) this.restoreFocus(was, now);
	}

	// Drops headers that left the page or moved under another shell, then hands the rest the current state.
	private pushPanels(state: PanelsState): void {
		for (const h of this.headers) {
			if (!this.owns(h)) this.headers.delete(h);
			else h.panels = state;
		}
	}

	// True when the node is connected and this shell is an ancestor, crossing shadow roots.
	private owns(node: Node): boolean {
		if (!node.isConnected) return false;
		for (let n: Node | null = node; n; ) {
			if (n === this) return true;
			n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : null);
		}
		return false;
	}

	private panelEl(panel: Panel): HTMLElement | null {
		return this.renderRoot.querySelector(panel === "nav" ? ".sidebar" : ".details");
	}

	private focusInto(panel: Panel): void {
		const el = this.panelEl(panel);
		if (!el) return;
		const slot = el.querySelector("slot");
		for (const root of slot?.assignedElements({ flatten: true }) ?? []) {
			const target = [root, ...root.querySelectorAll(FOCUSABLE)].find((n) => n.matches(FOCUSABLE) && (n as HTMLElement).checkVisibility?.() !== false);
			if (target) {
				(target as HTMLElement).focus();
				return;
			}
		}
		el.focus();
	}

	// Focus goes back to the opener only when it was in the closing drawer, or lost with it.
	private restoreFocus(panel: Panel, now: PanelsState): void {
		const opener = this.opener;
		this.opener = null;
		if (!opener?.isConnected || (now[panel].docked && now[panel].open)) return;
		const active = deepActiveElement();
		const el = this.panelEl(panel);
		if (!active || active === document.body || (el && flatContains(el, active))) (opener as HTMLElement).focus?.();
	}

	render() {
		const s = this.state;
		const drawer = drawerOf(s);
		// While a drawer is open the rest of the shell is inert, unless a sheet (wherever it lives) needs input.
		const blocked = drawer !== null && this.sheets === 0;
		const cls = ["layout", this.navOpen ? "nav-open" : "", drawer ? "drawer-open" : "", s.nav.docked && s.nav.open ? "" : "nav-closed", s.aside.docked && s.aside.open ? "" : "aside-closed"];
		const panel = (p: Panel) => {
			const ps = s[p];
			const isDrawer = ps.present && !ps.docked;
			return {
				cls: [p === "nav" ? "sidebar" : "details", isDrawer ? "drawer" : "", ps.open ? "open" : ""].filter(Boolean).join(" "),
				// Absent panels are no landmark; closed ones, and the one behind an open drawer, take no focus.
				hidden: !ps.present,
				inert: !ps.open || (blocked && drawer !== p),
				tabindex: isDrawer ? "-1" : nothing,
			};
		};
		const nav = panel("nav");
		const aside = panel("aside");
		return html`<div class=${cls.filter(Boolean).join(" ")}>
			<aside class=${nav.cls} aria-label=${this.navLabel} ?hidden=${nav.hidden} ?inert=${nav.inert} tabindex=${nav.tabindex} @click=${this.onSidebarClick}><slot name="nav" @slotchange=${this.onSlot("nav")}></slot></aside>
			<div class="overlay" @click=${this.closeDrawer}></div>
			<main class="main" ?inert=${blocked}><slot></slot></main>
			<aside class=${aside.cls} aria-label=${this.asideLabel} ?hidden=${aside.hidden} ?inert=${aside.inert} tabindex=${aside.tabindex}><slot name="aside" @slotchange=${this.onSlot("aside")}></slot></aside>
		</div>`;
	}
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])';

function drawerOf(s: PanelsState): Panel | null {
	for (const p of PANELS) if (s[p].present && !s[p].docked && s[p].open) return p;
	return null;
}

// Whether node sits inside container in the flattened tree (through slots and shadow roots).
function flatContains(container: Node, node: Node): boolean {
	for (let n: Node | null = node; n; n = (n as Element).assignedSlot ?? n.parentNode ?? (n instanceof ShadowRoot ? n.host : null)) {
		if (n === container) return true;
	}
	return false;
}

// The focused element, following open shadow roots down.
function deepActiveElement(): Element | null {
	let a = document.activeElement;
	while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
	return a;
}

// The panel named by a tk-*-panel event, or null when the detail is missing or names no panel.
function panelOf(e: Event): Panel | null {
	const p = (e as CustomEvent<{ panel?: unknown } | null>).detail?.panel;
	return p === "nav" || p === "aside" ? p : null;
}
customElements.define("tk-shell", TkShell);
