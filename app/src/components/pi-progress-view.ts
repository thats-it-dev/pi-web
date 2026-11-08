import { LitElement, css, html } from "lit";
import { sharedStyles } from "@thatsit/kit";
import type { ProgressView } from "../lib/progress-store.ts";
import { progressStyles, renderProgress } from "../render/progress.ts";

// Lucide icon (ISC): x.
const X_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>`;
const FOCUSABLE = "button, [href], summary, [tabindex]:not([tabindex='-1'])";

// The progress panel full screen, for phones and narrow windows. Like tk-sheet it is a dialog: focus moves in,
// Tab stays inside, Escape and the close button ask the session to close it (pi-close-progress).
export class PiProgressView extends LitElement {
	static properties = { view: { attribute: false }, now: { attribute: false }, selectedKey: { attribute: false }, modal: { type: Boolean } };
	declare view: ProgressView;
	declare now: number;
	declare selectedKey: string | null;
	declare modal: boolean; // a sheet sits on top: it takes Escape and focus

	static styles = [
		sharedStyles,
		progressStyles,
		css`
			:host { position: fixed; inset: 0; z-index: 20; display: flex; flex-direction: column; background: var(--bg); color: var(--text-primary); padding-top: env(safe-area-inset-top); }
			header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px 9px 18px; border-bottom: 1px solid var(--line); }
			h1 { font-family: var(--font-display); font-weight: 400; font-size: 1.15rem; letter-spacing: 0.02em; margin: 0; }
			.x { display: grid; place-items: center; width: 36px; height: 36px; margin: -6px -8px -6px 0; flex: none; color: var(--text-muted); }
			.x svg { width: 22px; height: 22px; }
			.body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
		`,
	];

	constructor() {
		super();
		this.now = Date.now();
		this.selectedKey = null;
		this.modal = false;
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.setAttribute("role", "dialog");
		this.setAttribute("aria-modal", "true");
		this.setAttribute("aria-label", "progress");
		document.addEventListener("keydown", this.onKey);
	}

	disconnectedCallback(): void {
		document.removeEventListener("keydown", this.onKey);
		super.disconnectedCallback();
	}

	firstUpdated(): void {
		this.renderRoot.querySelector<HTMLElement>(".x")?.focus();
	}

	private emit(type: string, detail?: unknown): void {
		this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
	}

	private close = () => this.emit("pi-close-progress");

	private onKey = (e: KeyboardEvent) => {
		if (this.modal || e.defaultPrevented) return;
		if (e.key === "Escape") this.close();
		else if (e.key === "Tab") this.trap(e);
	};

	// Keep Tab inside the view.
	private trap(e: KeyboardEvent): void {
		const items = [...this.renderRoot.querySelectorAll<HTMLElement>(FOCUSABLE)];
		if (!items.length) return;
		const first = items[0];
		const last = items[items.length - 1];
		const active = (this.renderRoot as ShadowRoot).activeElement;
		if (e.shiftKey && (active === first || !active)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || !active)) {
			e.preventDefault();
			first.focus();
		}
	}

	render() {
		return html`<header>
				<h1>progress</h1>
				<button class="x" aria-label="Close" @click=${this.close}>${X_ICON}</button>
			</header>
			<div class="body">
				${renderProgress(this.view, {
					now: this.now,
					selectedKey: this.selectedKey,
					openChild: (key) => this.emit("pi-open-child", key),
					openPlan: (path) => this.emit("pi-open-plan", path),
				})}
			</div>`;
	}
}
customElements.define("pi-progress-view", PiProgressView);
