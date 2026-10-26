import { LitElement, css, html, nothing } from "lit";
import { sharedStyles } from "./styles.ts";

// Lucide icon (ISC): x.
const X_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>`;

// Bottom sheet on phones, centered panel on wide screens. Content is slotted,
// so its styles live with whoever renders it.
export class TkSheet extends LitElement {
	static properties = { open: { type: Boolean, reflect: true }, heading: { type: String } };
	declare open: boolean;
	declare heading: string;

	static styles = [
		sharedStyles,
		css`
			.scrim { position: fixed; inset: 0; background: var(--overlay); z-index: 30; }
			.panel {
				position: fixed; z-index: 31; background: var(--bg); color: var(--text-primary);
				left: 50%; top: 50%; transform: translate(-50%, -50%);
				width: min(520px, calc(100vw - 32px)); max-height: min(80dvh, 720px);
				display: flex; flex-direction: column; border: 1px solid var(--border-color); border-radius: 6px;
				box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
			}
			header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px 8px; }
			h2 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.04em; font-size: 1.2rem; margin: 0; overflow-wrap: anywhere; }
			.x { display: grid; place-items: center; width: 36px; height: 36px; margin: -6px -8px -6px 0; flex: none; color: var(--text-muted); }
			.x svg { width: 22px; height: 22px; }
			.body { overflow-y: auto; padding: 4px 16px calc(16px + var(--safe-bottom)); }
			@media (max-width: 899px) {
				.panel { left: 0; right: 0; top: auto; bottom: 0; transform: none; width: 100%; max-height: 85dvh; border-radius: 12px 12px 0 0; border-width: 1px 0 0; }
			}
		`,
	];

	constructor() {
		super();
		this.open = false;
		this.heading = "";
	}

	private onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape" && this.open) this.close();
	};

	connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener("keydown", this.onKey);
	}

	disconnectedCallback(): void {
		document.removeEventListener("keydown", this.onKey);
		super.disconnectedCallback();
	}

	private close(): void {
		this.dispatchEvent(new CustomEvent("tk-close", { bubbles: true, composed: true }));
	}

	render() {
		if (!this.open) return nothing;
		return html`<div class="scrim" @click=${this.close}></div>
			<section class="panel" role="dialog" aria-modal="true" aria-label=${this.heading}>
				<header><h2>${this.heading}</h2><button class="x" aria-label="Close" @click=${this.close}>${X_ICON}</button></header>
				<div class="body"><slot></slot></div>
			</section>`;
	}
}
customElements.define("tk-sheet", TkSheet);
