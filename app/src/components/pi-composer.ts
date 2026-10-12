import { LitElement, css, html, nothing } from "lit";
import type { ImageInput, ModelInfo, PromptMode, ThinkingLevel } from "../../../shared/src/protocol.ts";
import { type SlashItem, filterSlash, slashQuery } from "../lib/slash.ts";
import { toast } from "../lib/toast.ts";
import { checkImageFile } from "../lib/images.ts";
import { UNAVAILABLE_IN_TERMINAL } from "../render/sheets.ts";
import { sharedStyles } from "../styles/shared.ts";

export interface SubmitDetail {
	text: string;
	images: ImageInput[];
	mode: PromptMode;
}

const LONG_PRESS_MS = 500;

// Lucide icons (ISC): send-horizontal and square.
const SEND_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z" /><path d="M6 12h16" /></svg>`;
const STOP_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" /></svg>`;

export class PiComposer extends LitElement {
	static properties = {
		streaming: { attribute: false },
		detached: { attribute: false },
		items: { attribute: false },
		canImages: { attribute: false },
		rpcOnlyDisabled: { attribute: false },
		queue: { attribute: false },
		statuses: { attribute: false },
		model: { attribute: false },
		thinking: { attribute: false },
		text: { state: true },
		images: { state: true },
		menuIndex: { state: true },
		menuDismissed: { state: true },
	};
	declare streaming: boolean;
	declare detached: boolean;
	declare items: SlashItem[];
	declare canImages: boolean;
	declare rpcOnlyDisabled: boolean;
	declare queue: { steering: string[]; followUp: string[] };
	declare statuses: string[];
	declare model: ModelInfo | null;
	declare thinking: ThinkingLevel | null;
	declare text: string;
	declare images: ImageInput[];
	declare menuIndex: number;
	declare menuDismissed: boolean;
	private pressTimer: ReturnType<typeof setTimeout> | undefined;
	private longPressed = false;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; border-top: 1px solid var(--line); background: var(--bg); padding: 8px 14px calc(10px + var(--safe-bottom)); position: relative; }
			.inner { max-width: 760px; margin: 0 auto; display: grid; gap: 6px; }
			.queue { display: flex; flex-wrap: wrap; gap: 6px; }
			.chip { font-size: 0.75rem; border: 1px dashed var(--border-color); border-radius: var(--radius); padding: 2px 8px; color: var(--text-secondary); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.menu { border: 1px solid var(--border-color); border-radius: var(--radius); background: var(--bg); font-size: 0.82rem; overflow: hidden; max-height: 40vh; overflow-y: auto; }
			.opt { display: flex; gap: 10px; padding: 6px 10px; cursor: pointer; align-items: baseline; }
			.opt.on { background: color-mix(in srgb, var(--primary), transparent 82%); }
			.opt.off { opacity: 0.5; }
			.opt code { font-family: var(--font-mono); flex: none; }
			.opt span { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
			.thumbs { display: flex; gap: 6px; }
			.thumb img { width: 48px; height: 48px; object-fit: cover; border-radius: var(--radius); border: 1px solid var(--line); }
			.box { display: grid; gap: 2px; border: 1px solid var(--border-color); border-radius: var(--radius); padding: 6px 6px 4px 10px; background: var(--bg); }
			textarea { width: 100%; min-width: 0; border: 0; padding: 4px 0; resize: none; background: transparent; line-height: 1.45; max-height: 40vh; outline: none; }
			.row { display: flex; gap: 6px; align-items: center; }
			.model { color: var(--primary); font-size: 0.8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; margin-right: auto; }
			.model b { font-weight: 500; }
			.icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); color: var(--text-secondary); font-size: 1.1rem; cursor: pointer; flex: none; }
			.icon svg { width: 20px; height: 20px; }
			.icon.send { color: #000; background: var(--primary); }
			.icon:disabled { opacity: 0.45; cursor: default; }
			.status { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 0.7rem; color: var(--text-muted); }
		`,
	];

	constructor() {
		super();
		this.streaming = false;
		this.detached = false;
		this.items = [];
		this.canImages = false;
		this.rpcOnlyDisabled = false;
		this.queue = { steering: [], followUp: [] };
		this.statuses = [];
		this.model = null;
		this.thinking = null;
		this.text = "";
		this.images = [];
		this.menuIndex = 0;
		this.menuDismissed = false;
	}

	setText(text: string): void {
		this.text = text;
		this.updateComplete.then(() => this.textarea?.focus());
	}

	// Put a failed message back unless the user already started typing again.
	restore(text: string, images: ImageInput[]): void {
		if (this.text || this.images.length) return;
		this.text = text;
		this.images = images;
	}

	private get textarea(): HTMLTextAreaElement | null {
		return this.renderRoot.querySelector("textarea");
	}

	private get menu(): SlashItem[] {
		const q = slashQuery(this.text);
		return q === null || this.menuDismissed ? [] : filterSlash(this.items, q);
	}

	private submit(mode: PromptMode): void {
		const text = this.text.trim();
		if (!text && this.images.length === 0) return;
		this.dispatchEvent(new CustomEvent<SubmitDetail>("pi-submit", { detail: { text, images: this.images, mode }, bubbles: true, composed: true }));
		this.text = "";
		this.images = [];
		this.menuIndex = 0;
		if (matchMedia("(pointer: coarse)").matches) this.textarea?.blur(); // put the keyboard away on a phone
	}

	private complete(item: SlashItem): void {
		if (item.rpcOnly && this.rpcOnlyDisabled) {
			toast(UNAVAILABLE_IN_TERMINAL, "warning");
			return;
		}
		this.setText(`/${item.name} `);
		this.menuIndex = 0;
	}

	private onInput = (e: Event) => {
		this.text = (e.target as HTMLTextAreaElement).value;
		this.menuDismissed = false;
		this.menuIndex = 0;
	};

	private onKey = (e: KeyboardEvent) => {
		const menu = this.menu;
		if (menu.length && !e.isComposing && e.keyCode !== 229) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const step = e.key === "ArrowDown" ? 1 : -1;
				this.menuIndex = (this.menuIndex + step + menu.length) % menu.length;
				return;
			}
			if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
				e.preventDefault();
				this.complete(menu[Math.min(this.menuIndex, menu.length - 1)]);
				return;
			}
			if (e.key === "Escape") {
				this.menuDismissed = true;
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) {
			e.preventDefault();
			this.submit(this.streaming ? "steer" : "send");
		}
	};

	private onPressStart = () => {
		this.longPressed = false;
		if (!this.streaming) return;
		this.pressTimer = setTimeout(() => {
			this.longPressed = true;
			this.submit("followUp");
		}, LONG_PRESS_MS);
	};

	private onPressEnd = () => clearTimeout(this.pressTimer);

	private onPressCancel = () => {
		clearTimeout(this.pressTimer);
		this.longPressed = false;
	};

	disconnectedCallback(): void {
		clearTimeout(this.pressTimer);
		this.longPressed = false;
		super.disconnectedCallback();
	}

	private onSendClick = () => {
		if (this.longPressed) {
			this.longPressed = false;
			return;
		}
		this.submit(this.streaming ? "steer" : "send");
	};

	private onFiles = async (e: Event) => {
		const input = e.target as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = "";
		const read = (f: File) =>
			new Promise<ImageInput>((resolve, reject) => {
				const r = new FileReader();
				r.onload = () => resolve({ mimeType: f.type, data: String(r.result).replace(/^data:[^,]*,/, "") });
				r.onerror = () => reject(r.error);
				r.readAsDataURL(f);
			});
		const accepted = files.filter((f) => checkImageFile(f));
		if (accepted.length < files.length) toast("Only PNG, JPEG, GIF or WebP images up to 5 MB can be attached.", "warning");
		const results = await Promise.allSettled(accepted.map(read));
		const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
		if (ok.length < accepted.length) toast("An image couldn't be read.", "error");
		if (ok.length) this.images = [...this.images, ...ok];
	};

	updated(): void {
		const ta = this.textarea;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight}px`;
	}

	render() {
		const menu = this.menu;
		const queued = [...this.queue.steering.map((t) => ["steer", t]), ...this.queue.followUp.map((t) => ["follow-up", t])];
		return html`<div class="inner">
			${queued.length ? html`<div class="queue" aria-label="Queued messages">${queued.map(([k, t]) => html`<span class="chip"><span class="label">${k}</span> ${t}</span>`)}</div>` : nothing}
			${menu.length
				? html`<div class="menu" id="slash-menu" role="listbox" aria-label="Commands">
						${menu.map(
							(item, i) => html`<div id="slash-opt-${i}" role="option" aria-selected=${i === this.menuIndex ? "true" : "false"} class="opt ${i === this.menuIndex ? "on" : ""} ${item.rpcOnly && this.rpcOnlyDisabled ? "off" : ""}" @pointerdown=${(e: Event) => {
								e.preventDefault();
								this.complete(item);
							}}><code>/${item.name}</code><span>${item.description}</span></div>`,
						)}
					</div>`
				: nothing}
			${this.images.length
				? html`<div class="thumbs">${this.images.map(
						(img, i) => html`<button class="thumb" aria-label="Remove image" @click=${() => (this.images = this.images.filter((_, j) => j !== i))}><img alt="" src="data:${img.mimeType};base64,${img.data}" /></button>`,
					)}</div>`
				: nothing}
			<div class="box">
				<textarea role="combobox" aria-autocomplete="list" aria-controls="slash-menu" aria-expanded=${menu.length ? "true" : "false"} aria-activedescendant=${menu.length ? `slash-opt-${Math.min(this.menuIndex, menu.length - 1)}` : nothing} aria-label="Message" rows="1" placeholder=${this.detached ? "continue here" : this.streaming ? "steer pi, or hold send to queue a follow-up" : "message pi, or / for commands"} .value=${this.text} @input=${this.onInput} @keydown=${this.onKey}></textarea>
				<div class="row">
					<button class="model u" aria-label=${`Model ${this.model?.name ?? "not loaded"}`} @click=${() => this.dispatchEvent(new CustomEvent("pi-open-sheet", { detail: "model", bubbles: true, composed: true }))}>
						${this.model ? html`<b>${this.model.name}</b> · ${this.thinking}` : "model"}
					</button>
					${this.canImages ? html`<label class="icon" aria-label="Attach image">＋<input class="sr-only" type="file" accept="image/*" multiple @change=${this.onFiles} /></label>` : nothing}
					${this.streaming ? html`<button class="icon" aria-label="stop" @click=${() => this.dispatchEvent(new CustomEvent("pi-abort", { bubbles: true, composed: true }))}>${STOP_ICON}</button>` : nothing}
					<button class="icon send" aria-label=${this.streaming ? "steer" : "send"} @pointerdown=${this.onPressStart} @pointerup=${this.onPressEnd} @pointerleave=${this.onPressEnd} @pointercancel=${this.onPressCancel} @click=${this.onSendClick}>${SEND_ICON}</button>
				</div>
			</div>
			${this.statuses.length ? html`<div class="status">${this.statuses.map((s) => html`<span>${s}</span>`)}</div>` : nothing}
		</div>`;
	}
}
customElements.define("pi-composer", PiComposer);
