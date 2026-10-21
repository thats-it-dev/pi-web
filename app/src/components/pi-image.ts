import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import type { ImageLoader } from "../lib/image-loader.ts";
import { sharedStyles } from "../styles/shared.ts";

export interface ImageBlock {
	mimeType: string;
	data?: string;
	ref?: string;
	width?: number;
	height?: number;
}

type State = "idle" | "loading" | "ready" | "failed";

export class PiImage extends LitElement {
	static properties = {
		block: { attribute: false },
		loader: { attribute: false },
		alt: { attribute: false },
		variant: { attribute: false },
		_state: { state: true },
		_url: { state: true },
		_open: { state: true },
	};
	declare block: ImageBlock | null;
	declare loader: ImageLoader | null;
	declare alt: string;
	declare variant: "figure" | "thumb";
	declare _state: State;
	declare _url: string;
	declare _open: boolean;
	private observer: IntersectionObserver | null = null;
	private requested: string | null = null;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; min-width: 0; }
			:host([variant="thumb"]) { display: inline-block; }
			button.pic { display: block; max-width: 100%; }
			img.pic, .ph { display: block; max-width: 100%; border-radius: var(--radius); }
			.figure img.pic { width: 100%; max-width: 100%; max-height: 70vh; height: auto; object-fit: contain; object-position: left top; image-rendering: pixelated; }
			.thumb img.pic { max-width: 160px; max-height: 160px; width: auto; height: auto; }
			.ph { background: var(--code-bg); min-height: 48px; width: 100%; max-width: 480px; }
			.figure .ph { max-width: 100%; max-height: 70vh; }
			.thumb .ph { width: 160px; }
			.fail { color: var(--text-secondary); font-size: 0.9em; }
			.viewer { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: rgba(0, 0, 0, 0.92); padding: 0; border: 0; width: 100%; height: 100%; cursor: zoom-out; touch-action: pinch-zoom; }
			.viewer img { width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; touch-action: pinch-zoom; }
		`,
	];

	constructor() {
		super();
		this.block = null;
		this.loader = null;
		this.alt = "image";
		this.variant = "figure";
		this._state = "idle";
		this._url = "";
		this._open = false;
	}

	private get src(): string {
		const b = this.block;
		if (!b) return "";
		return b.data !== undefined ? `data:${b.mimeType};base64,${b.data}` : this._url;
	}

	connectedCallback() {
		super.connectedCallback();
		// Lit doesn't re-render on reconnect, so re-arm the observer here.
		if (this.hasUpdated) this.arm();
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		removeEventListener("keydown", this.onKey);
		this.observer?.disconnect();
		this.observer = null;
	}
	private onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape" && this._open) this._open = false;
	};

	protected willUpdate(changed: PropertyValues) {
		if (changed.has("block") || changed.has("loader")) {
			this.requested = null;
			this._open = false;
			this._url = "";
			this._state = this.block?.data !== undefined ? "ready" : "idle";
			this.observer?.disconnect();
			this.observer = null;
		}
	}

	protected updated(changed: PropertyValues) {
		if (changed.has("_open")) {
			if (this._open) addEventListener("keydown", this.onKey);
			else removeEventListener("keydown", this.onKey);
		}
		this.arm();
	}

	private arm() {
		const ref = this.block?.data === undefined ? this.block?.ref : undefined;
		// Only an element still waiting to load needs an observer; an in-flight
		// load completes on its own even while detached.
		if (ref && this.loader && this._state === "idle" && !this.observer) {
			this.observer = new IntersectionObserver(
				(entries) => {
					if (!entries.some((e) => e.isIntersecting)) return;
					this.observer?.disconnect();
					this.observer = null;
					this.start(ref);
				},
				{ rootMargin: "400px" },
			);
			this.observer.observe(this);
		}
	}

	private start(ref: string) {
		const loader = this.loader;
		if (!loader || this.requested === ref) return;
		this.requested = ref;
		this._state = "loading";
		loader.load(ref).then(
			(url) => {
				if (this.requested !== ref || this.loader !== loader) return;
				this._url = url;
				this._state = "ready";
			},
			() => {
				if (this.requested === ref) this._state = "failed";
			},
		);
	}

	private fail = () => {
		this._open = false;
		this._state = "failed";
	};

	render() {
		const b = this.block;
		if (!b) return nothing;
		if (this._state === "failed") return html`<span class="fail">image unavailable</span>`;
		const src = this.src;
		const ratio = b.width && b.height ? `${b.width} / ${b.height}` : "";
		return html`<div class=${this.variant}>
			${src
				? html`<button class="pic" type="button" aria-label=${`View image: ${this.alt}`} @click=${() => (this._open = true)}>
						<img class="pic" alt=${this.alt} src=${src} width=${b.width ?? nothing} height=${b.height ?? nothing} @error=${this.fail} />
					</button>`
				: html`<div class="ph" style=${ratio ? `aspect-ratio: ${ratio}` : ""} aria-busy="true"></div>`}
			${this._open && src
				? html`<button class="viewer" type="button" aria-label="Close image" @click=${() => (this._open = false)}>
						<img alt=${this.alt} src=${src} />
					</button>`
				: nothing}
		</div>`;
	}
}
customElements.define("pi-image", PiImage);
