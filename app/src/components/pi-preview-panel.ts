import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import { EXPAND_ICON, EXTERNAL_LINK_ICON, REFRESH_ICON, X_ICON, sharedStyles } from "@thatsit/kit";
import type { PreviewState } from "../../../shared/src/preview.ts";
import { type AsideSize, POLL_MS, type PreviewMode, VIEWPORTS, type Viewport, nextPollDelay, shouldReload, stageFor } from "../lib/preview-ui.ts";
import { previewCardStyles, renderPreviewCard } from "../render/messages.ts";

const KIND_LABEL = { dev: "dev server", static: "static", pages: "Pages" } as const;

// The Preview tab: a header strip (url, viewport presets, reload, snap, pop-out), the app in an iframe and a status
// line with the server's health. On a phone (mode "card") there is no iframe: the card from the reply plus the status.
// Asks the app to snap the size (pi-preview-snap), go back to the chat (pi-preview-back) or close it (pi-preview-close).
export class PiPreviewPanel extends LitElement {
	static properties = {
		preview: { attribute: false },
		mode: { attribute: false },
		size: { attribute: false },
		active: { attribute: false },
		viewport: { state: true },
		alive: { state: true },
		reloadKey: { state: true },
		stage: { state: true },
	};
	declare preview: PreviewState | null;
	declare mode: PreviewMode;
	declare size: AsideSize;
	declare active: boolean; // the Preview tab is the one showing and the aside is open: only then the health poll runs
	declare viewport: Viewport;
	declare alive: boolean | null; // the server answered the last poll; null before the first answer, and for Pages
	declare reloadKey: number; // bumped when the same url is announced again: the iframe reloads in place
	declare stage: { w: number; h: number };

	private poller: ReturnType<typeof setTimeout> | undefined;
	private pollGen = 0; // bumped by stopPoll: an answer from an earlier run schedules nothing
	private pollDelay = POLL_MS;
	private observed: Element | null = null;
	private loadedKey = 0; // the reloadKey the iframe last loaded
	private resizer = new ResizeObserver((entries) => {
		const r = entries[entries.length - 1]?.contentRect;
		if (r) this.stage = { w: Math.round(r.width), h: Math.round(r.height) };
	});

	static styles = [
		sharedStyles,
		previewCardStyles,
		css`
			:host { display: block; height: 100%; }
			.wrap { display: flex; flex-direction: column; height: 100%; }
			.hdr { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); }
			.hdr .name { font-weight: 600; white-space: nowrap; }
			.hdr code { flex: 1 1 120px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-secondary); }
			.hdr .seg button { padding: 3px 10px; font-size: 0.8rem; }
			.stage { position: relative; flex: 1; min-height: 0; background: var(--panel); overflow: hidden; display: grid; place-items: start center; justify-content: center; }
			iframe { border: 0; background: #fff; transform-origin: top center; }
			.status { display: flex; gap: 8px; align-items: center; padding: 6px 12px; border-top: 1px solid var(--line); font-size: 0.72rem; color: var(--text-secondary); }
			.dot { background: var(--line); }
			.card { padding: 12px; }
			.card .status { border-top: 0; padding: 0; }
		`,
	];

	constructor() {
		super();
		this.preview = null;
		this.mode = "panel";
		this.size = "default";
		this.active = false;
		this.viewport = "fit";
		this.alive = null;
		this.reloadKey = 0;
		this.stage = { w: 0, h: 0 };
	}

	connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener("visibilitychange", this.onVisibility);
		// The first poll comes from the first willUpdate (preview is always in it); this restarts a re-attached panel.
		if (this.hasUpdated) this.startPoll();
	}

	disconnectedCallback(): void {
		document.removeEventListener("visibilitychange", this.onVisibility);
		this.stopPoll();
		this.resizer.disconnect();
		this.observed = null;
		super.disconnectedCallback();
	}

	willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("preview")) {
			const was = changed.get("preview") as PreviewState | null | undefined;
			const now = this.preview;
			// The same url from a new preview call (pi restarted it): reload in place rather than re-mount.
			// The same call landing in the messages (its at going 0 -> a time) keeps its id: no reload.
			if (shouldReload(was, now)) this.reloadKey++;
			if (!was || !now || was.url !== now.url || was.kind !== now.kind) this.alive = null;
		} else if (!changed.has("active")) return;
		if (this.isConnected) this.startPoll();
	}

	updated(): void {
		const stage = this.renderRoot.querySelector(".stage");
		if (stage !== this.observed) {
			if (this.observed) this.resizer.unobserve(this.observed);
			this.observed = stage;
			if (stage) this.resizer.observe(stage);
			else if (this.stage.w || this.stage.h) this.stage = { w: 0, h: 0 };
		}
		if (this.reloadKey !== this.loadedKey) {
			this.loadedKey = this.reloadKey;
			const frame = this.renderRoot.querySelector("iframe");
			if (frame && this.preview) frame.src = this.preview.url; // setting src again reloads, even when it is unchanged
		}
	}

	private onVisibility = () => {
		if (document.visibilityState === "hidden") this.stopPoll();
		else this.startPoll();
	};

	// Polls at once, then every 15s (backing off to 60s while it is down), while the page is visible and the tab is
	// showing in an open aside. Pages previews are not ours to watch.
	private startPoll(): void {
		this.stopPoll();
		const p = this.preview;
		if (!p || p.kind === "pages" || !this.active || document.visibilityState === "hidden") return;
		this.pollDelay = POLL_MS;
		this.poll(p.url, this.pollGen);
	}

	private stopPoll(): void {
		clearTimeout(this.poller);
		this.poller = undefined;
		this.pollGen++;
	}

	// no-cors: the dev server's answer is opaque, but it resolving at all means something is listening.
	private poll(url: string, gen: number): void {
		fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store" }).then(
			() => this.answer(url, gen, true),
			() => this.answer(url, gen, false),
		);
	}

	private answer(url: string, gen: number, alive: boolean): void {
		if (this.preview?.url !== url) return; // an answer for a url no longer shown
		this.alive = alive;
		this.requestUpdate(); // the uptime moves on
		if (gen !== this.pollGen) return; // stopped or restarted since: that run schedules its own
		this.pollDelay = nextPollDelay(this.pollDelay, alive);
		this.poller = setTimeout(() => this.poll(url, gen), this.pollDelay);
	}

	private emit(type: string): void {
		this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
	}

	render() {
		const p = this.preview;
		if (!p) return nothing;
		if (this.mode === "card") return html`<div class="card">${renderPreviewCard({ url: p.url, label: p.label, kind: p.kind })}${this.renderStatus(p)}</div>`;
		const full = this.mode === "fullscreen";
		return html`<div class="wrap">
			<div class="hdr">
				${full ? html`<button class="btn ghost" @click=${() => this.emit("pi-preview-back")}>Back to chat</button>` : nothing}
				${p.label ? html`<span class="name">${p.label}</span>` : nothing}
				<code title=${p.url}>${p.url}</code>
				${full
					? nothing
					: html`<div class="seg" role="group" aria-label="Viewport">
							${VIEWPORTS.map((v) => html`<button class=${v === this.viewport ? "on" : ""} aria-pressed=${v === this.viewport} @click=${() => (this.viewport = v)}>${v}</button>`)}
						</div>`}
				<button class="icon-btn" aria-label="Reload preview" @click=${() => this.reloadKey++}>${REFRESH_ICON}</button>
				${full ? nothing : html`<button class="icon-btn" aria-label="Resize preview" title=${`Size: ${this.size}`} @click=${() => this.emit("pi-preview-snap")}>${EXPAND_ICON}</button>`}
				<a class="icon-btn" href=${p.url} target="_blank" rel="noopener" aria-label="Open in a new tab">${EXTERNAL_LINK_ICON}</a>
				${full || p.kind === "pages" ? html`<button class="icon-btn" aria-label="Close preview" @click=${() => this.emit("pi-preview-close")}>${X_ICON}</button>` : nothing}
			</div>
			<div class="stage">${this.renderFrame(p, full)}</div>
			${this.renderStatus(p)}
		</div>`;
	}

	// Laid out from the stage's size once it has one; till then (or not laid out at all) the frame just fills it.
	private renderFrame(p: PreviewState, full: boolean) {
		const { w, h } = this.stage;
		let style = "width:100%;height:100%";
		if (w > 0 && h > 0) {
			const s = stageFor(full ? "fit" : this.viewport, w, h);
			style = `width:${s.width}px;height:${s.height}px;transform:scale(${s.scale})`;
		}
		return html`<iframe title=${`Preview of ${p.label}`} src=${p.url} referrerpolicy="no-referrer" style=${style}></iframe>`;
	}

	private renderStatus(p: PreviewState) {
		const dot = this.alive ? "live" : this.alive === false ? "error" : "";
		const parts = [p.label || hostOf(p.url)];
		if (this.alive === false) parts.push("stopped · pi can start it again");
		else {
			parts.push(KIND_LABEL[p.kind]);
			if (p.kind !== "pages" && p.at > 0) parts.push(`up ${uptime(Date.now() - p.at)}`);
		}
		return html`<div class="status"><span class="dot ${dot}"></span><span>${parts.join(" · ")}</span></div>`;
	}
}
customElements.define("pi-preview-panel", PiPreviewPanel);

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function uptime(ms: number): string {
	const m = Math.max(0, Math.floor(ms / 60_000));
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
