import { LitElement, css, html } from "lit";
import { sharedStyles } from "./styles.ts";
import { TOAST_EVENT, type ToastDetail } from "./toast.ts";

interface Item extends ToastDetail {
	id: number;
}

export class TkToasts extends LitElement {
	static properties = { items: { state: true } };
	declare items: Item[];
	private n = 0;

	// --tk-toast-bottom lets an app lift the stack above its own bottom bar.
	static styles = [
		sharedStyles,
		css`
			.stack { position: fixed; left: 50%; transform: translateX(-50%); bottom: var(--tk-toast-bottom, calc(96px + env(safe-area-inset-bottom))); z-index: 50; display: grid; gap: 8px; width: min(92vw, 460px); pointer-events: none; }
			.toast { pointer-events: auto; background: var(--text-primary); color: var(--bg); border-radius: var(--radius); padding: 9px 12px; font-size: 0.9rem; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25); cursor: pointer; overflow-wrap: anywhere; white-space: pre-wrap; }
			.toast.warning { border-left: 4px solid var(--primary); }
			.toast.error { border-left: 4px solid var(--accent); }
		`,
	];

	constructor() {
		super();
		this.items = [];
	}

	private onToast = (e: Event) => {
		const d = (e as CustomEvent<ToastDetail>).detail;
		const id = ++this.n;
		this.items = [...this.items, { ...d, id }].slice(-4);
		setTimeout(() => this.dismiss(id), d.level === "error" ? 8000 : 4000);
	};

	connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener(TOAST_EVENT, this.onToast);
	}

	disconnectedCallback(): void {
		window.removeEventListener(TOAST_EVENT, this.onToast);
		super.disconnectedCallback();
	}

	private dismiss(id: number): void {
		this.items = this.items.filter((t) => t.id !== id);
	}

	render() {
		return html`<div class="stack" role="status" aria-live="polite">
			${this.items.map((t) => html`<div class="toast ${t.level}" @click=${() => this.dismiss(t.id)}>${t.message}</div>`)}
		</div>`;
	}
}
customElements.define("tk-toasts", TkToasts);
