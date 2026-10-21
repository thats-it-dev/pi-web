import { LitElement, css, html } from "lit";
import { sharedStyles } from "./styles.ts";

// Two-pane app layout: nav slot in a sidebar (a drawer on phones), default slot as the main area.
export class TkShell extends LitElement {
	static properties = { navOpen: { type: Boolean, attribute: false }, navLabel: { attribute: "nav-label" } };
	declare navOpen: boolean;
	declare navLabel: string;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; height: 100%; }
			.layout { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); height: 100%; }
			.sidebar { border-right: 1px solid var(--line); min-width: 0; min-height: 0; background: var(--bg); padding-top: env(safe-area-inset-top); }
			.main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
			/* the slot is display: contents, so the app's own children are what flex */
			::slotted(:not([slot])) { flex: 1; min-height: 0; }
			.overlay { display: none; }
			@media (max-width: 899px) {
				.layout { grid-template-columns: minmax(0, 1fr); }
				.sidebar { position: fixed; inset: 0 auto 0 0; width: min(80vw, 360px); z-index: 20; transform: translateX(-100%); transition: transform 0.25s ease; box-shadow: 2px 0 12px rgba(0, 0, 0, 0.2); }
				.nav-open .sidebar { transform: none; }
				.overlay { display: block; position: fixed; inset: 0; background: var(--overlay); z-index: 10; opacity: 0; pointer-events: none; transition: opacity 0.25s; }
				.nav-open .overlay { opacity: 1; pointer-events: auto; }
			}
		`,
	];

	constructor() {
		super();
		this.navOpen = false;
		this.navLabel = "Navigation";
	}

	private onHash = () => {
		this.navOpen = false;
	};
	private onOpenNav = () => {
		this.navOpen = true;
	};
	// Following a link closes the drawer. hashchange covers most links, but
	// tapping the current page's link changes nothing, so catch the click.
	private onSidebarClick = (e: Event) => {
		if (e.composedPath().some((el) => el instanceof HTMLAnchorElement)) this.navOpen = false;
	};

	connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener("hashchange", this.onHash);
		this.addEventListener("tk-open-nav", this.onOpenNav);
	}

	disconnectedCallback(): void {
		window.removeEventListener("hashchange", this.onHash);
		this.removeEventListener("tk-open-nav", this.onOpenNav);
		super.disconnectedCallback();
	}

	render() {
		return html`<div class="layout ${this.navOpen ? "nav-open" : ""}">
			<aside class="sidebar" aria-label=${this.navLabel} @click=${this.onSidebarClick}><slot name="nav"></slot></aside>
			<div class="overlay" @click=${() => (this.navOpen = false)}></div>
			<main class="main"><slot></slot></main>
		</div>`;
	}
}
customElements.define("tk-shell", TkShell);
