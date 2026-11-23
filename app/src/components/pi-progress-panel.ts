import { LitElement, css, html, nothing } from "lit";
import { sharedStyles } from "@thatsit/kit";
import type { ProgressStore } from "../lib/progress-store.ts";
import { previewMode } from "../lib/preview-ui.ts";
import { progressStyles, renderProgress } from "../render/progress.ts";

// The session's progress (goal, plan, to-dos, subagents) in tk-shell's aside panel: a docked column on wide
// screens, a drawer otherwise. Rows ask the session to open a subagent or the plan (pi-open-child, pi-open-plan).
export class PiProgressPanel extends LitElement {
	static properties = { store: { attribute: false }, selectedKey: { attribute: false } };
	declare store: ProgressStore | null;
	declare selectedKey: string | null; // the subagent whose thread is open, marked in the list

	private watched: ProgressStore | null = null;
	private ticker: ReturnType<typeof setInterval> | undefined;

	static styles = [
		sharedStyles,
		progressStyles,
		css`
			:host { display: block; height: 100%; }
			.body { height: 100%; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; padding-bottom: calc(16px + var(--safe-bottom)); }
		`,
	];

	constructor() {
		super();
		this.store = null;
		this.selectedKey = null;
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.watch(this.store);
	}

	disconnectedCallback(): void {
		this.watch(null);
		super.disconnectedCallback();
	}

	willUpdate(): void {
		if (this.isConnected && this.store !== this.watched) this.watch(this.store);
	}

	private watch(store: ProgressStore | null): void {
		this.watched?.removeEventListener("change", this.onChange);
		this.watched = store;
		store?.addEventListener("change", this.onChange);
		this.syncTicker();
	}

	private onChange = () => {
		this.requestUpdate();
		this.syncTicker();
	};

	// Re-render once a second while a subagent or the run is going, so elapsed times move.
	private syncTicker(): void {
		const v = this.watched?.view;
		const running = Boolean(v && (v.subagents.recent.concat(v.subagents.earlier).some((c) => c.state === "running") || (v.activity === "working" && v.runs)));
		if (running && !this.ticker) this.ticker = setInterval(() => this.requestUpdate(), 1000);
		if (!running) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}

	private emit(type: string, detail: string): void {
		this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
	}

	// pi-app answers by showing the Preview tab and cancelling the event; true then stops the link's navigation.
	private openPreview(url: string, label: string): boolean {
		const ev = new CustomEvent("pi-open-preview", { detail: { url, label, kind: "pages" }, bubbles: true, composed: true, cancelable: true });
		this.dispatchEvent(ev);
		return ev.defaultPrevented;
	}

	render() {
		const view = this.store?.view;
		if (!view || view.empty) return nothing;
		return html`<div class="body">
			${renderProgress(view, {
				now: Date.now(),
				selectedKey: this.selectedKey,
				openChild: (key) => this.emit("pi-open-child", key),
				openPlan: (path) => this.emit("pi-open-plan", path),
				mode: previewMode(window.innerWidth),
				openPreview: (url, label) => this.openPreview(url, label),
			})}
		</div>`;
	}
}
customElements.define("pi-progress-panel", PiProgressPanel);
