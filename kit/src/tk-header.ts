import { LitElement, css, html } from "lit";
import { sharedStyles } from "./styles.ts";

// Sticky top bar: a menu button (phones only) beside the slotted title, an optional
// right-hand actions slot, then whatever else the app puts underneath in the
// default slot.
export class TkHeader extends LitElement {
	static properties = { tucked: { type: Boolean, reflect: true }, menuLabel: { attribute: "menu-label" } };
	declare tucked: boolean;
	declare menuLabel: string;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); padding-top: env(safe-area-inset-top); transition: transform 0.2s ease; }
			header { display: grid; gap: 6px; padding: 10px 18px 9px; }
			.l1 { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
			.menu { display: none; font-size: 1.2rem; line-height: 1; align-self: center; }
			::slotted(h1) { font-family: var(--font-display); font-weight: 400; font-size: 1.15rem; letter-spacing: 0.02em; margin: 0; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			@media (max-width: 899px) {
				header { padding: 8px 14px; }
				.menu { display: inline-block; }
				:host([tucked]) { transform: translateY(-100%); }
			}
		`,
	];

	constructor() {
		super();
		this.tucked = false;
		this.menuLabel = "Open menu";
	}

	private openNav(): void {
		this.dispatchEvent(new CustomEvent("tk-open-nav", { bubbles: true, composed: true }));
	}

	render() {
		return html`<header>
			<div class="l1">
				<button class="menu" aria-label=${this.menuLabel} @click=${this.openNav}>☰</button>
				<slot name="title"></slot>
				<slot name="actions"></slot>
			</div>
			<slot></slot>
		</header>`;
	}
}
customElements.define("tk-header", TkHeader);
