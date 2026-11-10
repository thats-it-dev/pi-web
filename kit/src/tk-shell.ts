import { LitElement, css, html } from "lit";
import { sharedStyles } from "./styles.ts";
import { type Hidden, type Mode, type Panel, type PanelsState, PHONE_MAX, WIDE_MIN, panelsState, readHidden, writeHidden } from "./panels.ts";

const PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`;
const WIDE_QUERY = `(min-width: ${WIDE_MIN}px)`;
const PANELS: Panel[] = ["nav", "aside"];

// App layout: nav slot in a left panel, aside slot in a right panel, default slot as the main area.
// Docked panels are columns the user can hide; undocked ones are drawers (nav drawer on phones).
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

	static styles = [
		sharedStyles,
		css`
			:host { display: block; height: 100%; }
			.layout { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr) var(--aside-w); height: 100%; transition: grid-template-columns 0.25s ease; }
			.layout.nav-closed { grid-template-columns: 0 minmax(0, 1fr) var(--aside-w); }
			.layout.aside-closed { grid-template-columns: var(--sidebar-w) minmax(0, 1fr) 0; }
			.layout.nav-closed.aside-closed { grid-template-columns: 0 minmax(0, 1fr) 0; }
			.sidebar { border-right: 1px solid var(--line); min-width: 0; min-height: 0; overflow: hidden; background: var(--bg); padding-top: env(safe-area-inset-top); }
			.details { border-left: 1px solid var(--line); min-width: 0; min-height: 0; overflow: hidden; background: var(--bg); padding-top: env(safe-area-inset-top); }
			/* a collapsed column keeps no border, or it would stick out of its 0-wide track */
			.nav-closed .sidebar, .aside-closed .details { border-width: 0; }
			.main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
			/* the slot is display: contents, so the app's own children are what flex */
			::slotted(:not([slot])) { flex: 1; min-height: 0; }
			.overlay { display: none; }
			@media (max-width: 899px) {
				.layout, .layout.nav-closed, .layout.aside-closed, .layout.nav-closed.aside-closed { grid-template-columns: minmax(0, 1fr); }
				.details { display: none; }
				.sidebar { position: fixed; inset: 0 auto 0 0; width: min(80vw, 360px); z-index: 20; transform: translateX(-100%); transition: transform 0.25s ease; box-shadow: 2px 0 12px rgba(0, 0, 0, 0.2); border-width: 1px; border-left-width: 0; border-top-width: 0; border-bottom-width: 0; }
				.nav-open .sidebar { transform: none; }
				.overlay { display: block; position: fixed; inset: 0; background: var(--overlay); z-index: 10; opacity: 0; pointer-events: none; transition: opacity 0.25s; }
				.nav-open .overlay { opacity: 1; pointer-events: auto; }
			}
		`,
	];

	private phoneMq = matchMedia(PHONE_QUERY);
	private wideMq = matchMedia(WIDE_QUERY);
	// Last state announced through tk-panel-change; null until the first render.
	private lastState: PanelsState | null = null;

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
		// Added here, not in connectedCallback, so a header connecting in the same upgrade pass is never missed.
		this.addEventListener("tk-open-nav", () => this.show("nav"));
		this.addEventListener("tk-toggle-panel", (e) => this.toggle(panelOf(e)));
		this.addEventListener("tk-show-panel", (e) => this.show(panelOf(e)));
		this.addEventListener("tk-hide-panel", (e) => this.hide(panelOf(e)));
	}

	private computeMode(): Mode {
		return this.phoneMq.matches ? "phone" : this.wideMq.matches ? "wide" : "mid";
	}

	private onMode = () => {
		this.mode = this.computeMode();
	};
	private onHash = () => {
		this.navOpen = false;
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
	}

	disconnectedCallback(): void {
		window.removeEventListener("hashchange", this.onHash);
		this.phoneMq.removeEventListener("change", this.onMode);
		this.wideMq.removeEventListener("change", this.onMode);
		super.disconnectedCallback();
	}

	private get hiddenFlags(): Hidden {
		return { nav: this.navHidden, aside: this.asideHidden };
	}

	private get state(): PanelsState {
		const drawer: Panel | null = this.navOpen ? "nav" : this.asideOpen ? "aside" : null;
		return panelsState({ mode: this.mode, present: this.present, hidden: this.hiddenFlags, drawer });
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

	protected updated(): void {
		const now = this.state;
		const prev = this.lastState;
		this.lastState = now;
		if (!prev) return;
		for (const p of PANELS) {
			if (prev[p].open === now[p].open && prev[p].docked === now[p].docked) continue;
			this.dispatchEvent(new CustomEvent("tk-panel-change", { detail: { panel: p, open: now[p].open, docked: now[p].docked }, bubbles: true, composed: true }));
		}
	}

	render() {
		const s = this.state;
		const cls = ["layout", this.navOpen ? "nav-open" : "", s.nav.docked && s.nav.open ? "" : "nav-closed", s.aside.docked && s.aside.open ? "" : "aside-closed"];
		return html`<div class=${cls.filter(Boolean).join(" ")}>
			<aside class="sidebar" aria-label=${this.navLabel} @click=${this.onSidebarClick}><slot name="nav" @slotchange=${this.onSlot("nav")}></slot></aside>
			<div class="overlay" @click=${() => (this.navOpen = false)}></div>
			<main class="main"><slot></slot></main>
			<aside class="details" aria-label=${this.asideLabel}><slot name="aside" @slotchange=${this.onSlot("aside")}></slot></aside>
		</div>`;
	}
}

function panelOf(e: Event): Panel {
	return (e as CustomEvent<{ panel: Panel }>).detail.panel;
}
customElements.define("tk-shell", TkShell);
