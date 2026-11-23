import { LitElement, css, html, nothing } from "lit";
import { sharedStyles } from "@thatsit/kit";
import type { PreviewState } from "../../../shared/src/preview.ts";
import type { AsideTab } from "../lib/aside-state.ts";
import type { AsideSize, PreviewMode } from "../lib/preview-ui.ts";
import type { ProgressStore } from "../lib/progress-store.ts";
import "./pi-preview-panel.ts";
import "./pi-progress-panel.ts";

// The shell's aside: two tabs, Progress and Preview. The tab row shows only when both have content, and not while
// the preview is full screen (its own bar has Back). Both panels stay mounted while they have content, so switching
// tabs keeps the preview's page and the progress list where they were. pi-open-child / pi-open-plan bubble through.
export class PiAside extends LitElement {
	static properties = {
		progress: { attribute: false },
		preview: { attribute: false },
		tab: { attribute: false },
		mode: { attribute: false },
		size: { attribute: false },
		selectedKey: { attribute: false },
	};
	declare progress: ProgressStore | null;
	declare preview: PreviewState | null;
	declare tab: AsideTab;
	declare mode: PreviewMode;
	declare size: AsideSize;
	declare selectedKey: string | null;

	static styles = [
		sharedStyles,
		css`
			:host { display: flex; flex-direction: column; height: 100%; }
			.tabs { display: flex; gap: 18px; padding: 10px 14px 8px; border-bottom: 1px solid var(--line); flex: none; }
			.tabs button { font-size: 0.85rem; padding: 2px 0; }
			.tabs button:not(.on) { color: var(--text-secondary); }
			.pane { flex: 1; min-height: 0; }
			[hidden] { display: none !important; }
		`,
	];

	constructor() {
		super();
		this.progress = null;
		this.preview = null;
		this.tab = "progress";
		this.mode = "panel";
		this.size = "default";
		this.selectedKey = null;
	}

	private pick(tab: AsideTab): void {
		if (tab === this.tab) return;
		this.dispatchEvent(new CustomEvent("pi-aside-tab", { detail: { tab }, bubbles: true, composed: true }));
	}

	render() {
		const hasProgress = this.progress !== null;
		const hasPreview = this.preview !== null;
		const tab = this.tab; // pi-app's nextTab never picks a tab without content
		const fullscreen = tab === "preview" && this.mode === "fullscreen";
		const tabs = hasProgress && hasPreview && !fullscreen;
		return html`
			${tabs
				? html`<div class="tabs">
						<button class="u ${tab === "progress" ? "on" : ""}" aria-pressed=${tab === "progress"} @click=${() => this.pick("progress")}>Progress</button>
						<button class="u ${tab === "preview" ? "on" : ""}" aria-pressed=${tab === "preview"} @click=${() => this.pick("preview")}>Preview</button>
					</div>`
				: nothing}
			${hasProgress
				? html`<pi-progress-panel class="pane" ?hidden=${tab !== "progress"} .store=${this.progress} .selectedKey=${this.selectedKey}></pi-progress-panel>`
				: nothing}
			${hasPreview
				? html`<pi-preview-panel class="pane" ?hidden=${tab !== "preview"} .preview=${this.preview} .mode=${this.mode} .size=${this.size}></pi-preview-panel>`
				: nothing}
		`;
	}
}
customElements.define("pi-aside", PiAside);
