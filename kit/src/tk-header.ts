import { LitElement, css, html, nothing } from "lit";
import { MENU_ICON, PANEL_LEFT_ICON, PANEL_RIGHT_ICON } from "./icons.ts";
import type { Panel, PanelsState } from "./panels.ts";
import { sharedStyles } from "./styles.ts";

// Sticky top bar: a menu button (phones only) beside the slotted title, an optional
// right-hand actions slot, then whatever else the app puts underneath in the
// default slot.
export class TkHeader extends LitElement {
	static properties = {
		tucked: { type: Boolean, reflect: true },
		menuLabel: { attribute: "menu-label" },
		asideLabel: { attribute: "aside-label" },
		asideBadge: { attribute: "aside-badge" },
		panels: { attribute: false },
	};
	declare tucked: boolean;
	declare menuLabel: string;
	declare asideLabel: string;
	declare asideBadge: string;
	/** Panel layout state, set by an enclosing tk-shell; null outside one. */
	declare panels: PanelsState | null;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); padding-top: env(safe-area-inset-top); transition: transform 0.2s ease; }
			header { display: grid; gap: 6px; padding: 10px 18px 9px; }
			.l1 { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
			.menu:not(.icon-btn) { display: none; font-size: 1.2rem; line-height: 1; align-self: center; }
			.menu.icon-btn { align-self: center; margin-left: -8px; }
			.aside-toggle { width: auto; min-width: 36px; gap: 6px; grid-auto-flow: column; align-self: center; }
			::slotted(h1) { font-family: var(--font-display); font-weight: 400; font-size: 1.15rem; letter-spacing: 0.02em; margin: 0; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			::slotted([slot="actions"]) { flex: none; align-self: center; }
			@media (max-width: 899px) {
				header { padding: 8px 14px; }
				.menu:not(.icon-btn) { display: inline-block; }
				:host([tucked]) { transform: translateY(-100%); }
			}
		`,
	];

	constructor() {
		super();
		this.tucked = false;
		this.menuLabel = "Open menu";
		this.asideLabel = "Details";
		this.asideBadge = "";
		this.panels = null;
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.announce();
		// Upgraded before an enclosing tk-shell was defined: nobody heard the first announcement, so repeat it.
		if (!this.panels) void customElements.whenDefined("tk-shell").then(() => this.isConnected && !this.panels && this.announce());
	}

	disconnectedCallback(): void {
		// Outside a shell there are no panel buttons; a shell stops tracking a header that is no longer connected.
		this.panels = null;
		super.disconnectedCallback();
	}

	private announce(): void {
		this.dispatchEvent(new CustomEvent("tk-header-connect", { detail: { header: this }, bubbles: true, composed: true }));
	}

	private openNav(): void {
		this.dispatchEvent(new CustomEvent("tk-open-nav", { bubbles: true, composed: true }));
	}

	private toggle(panel: Panel): void {
		// tk-open-nav is for listeners outside the kit; the shell treats it as show, so it agrees with the toggle.
		const opening = !this.panels?.[panel].open;
		this.dispatchEvent(new CustomEvent("tk-toggle-panel", { detail: { panel }, bubbles: true, composed: true }));
		if (opening && panel === "nav") this.openNav();
	}

	private renderPanelButtons() {
		const p = this.panels!;
		const left = p.nav.present
			? html`<button class="menu icon-btn" aria-label=${this.menuLabel} aria-expanded=${String(p.nav.open)} @click=${() => this.toggle("nav")}>${p.nav.docked ? PANEL_LEFT_ICON : MENU_ICON}</button>`
			: nothing;
		const right = p.aside.present
			? html`<button class="aside-toggle icon-btn" aria-label=${this.asideLabel} aria-expanded=${String(p.aside.open)} @click=${() => this.toggle("aside")}>${PANEL_RIGHT_ICON}${this.asideBadge ? html`<span class="badge">${this.asideBadge}</span>` : nothing}</button>`
			: nothing;
		return { left, right };
	}

	render() {
		const { left, right } = this.panels
			? this.renderPanelButtons()
			: { left: html`<button class="menu" aria-label=${this.menuLabel} @click=${this.openNav}>☰</button>`, right: nothing };
		return html`<header>
			<div class="l1">
				${left}
				<slot name="title"></slot>
				<slot name="actions"></slot>
				${right}
			</div>
			<slot></slot>
		</header>`;
	}
}
customElements.define("tk-header", TkHeader);
