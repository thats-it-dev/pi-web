import { LitElement, css, html, nothing } from "lit";
import { sharedStyles, toast } from "@thatsit/kit";
import type { FileInput, ImageInput, ModelInfo, PromptMode, ThinkingLevel } from "../../../shared/src/protocol.ts";
import { type SlashItem, filterSlash, slashQuery } from "../lib/slash.ts";
import { type MentionEntry, applyMention, mentionAt } from "../lib/mention.ts";
import { checkImageFile } from "../lib/images.ts";
import { formatBytes, summarizeAttachments } from "../../../shared/src/attachments.ts";
import { type Attachment, acceptFiles, attachmentBytes, readAsBase64, routeAttachments } from "../lib/files.ts";
import { UNAVAILABLE_IN_TERMINAL } from "../render/sheets.ts";
import { enterSends } from "../lib/mobile.ts";

export interface SubmitDetail {
	text: string;
	images: ImageInput[];
	files: FileInput[];
	mode: PromptMode;
}

const LONG_PRESS_MS = 500;
const FILE_SEARCH_DELAY_MS = 120;

export type FileSearch = (query: string, signal: AbortSignal) => Promise<MentionEntry[]>;

type Menu = { kind: "slash"; items: SlashItem[] } | { kind: "files"; items: MentionEntry[] };

// Lucide icons (ISC): plus, arrow-up, square and paperclip.
const PLUS_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="M12 5v14" /></svg>`;
const SEND_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></svg>`;
const STOP_ICON = html`<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect width="14" height="14" x="5" y="5" rx="2" /></svg>`;
export const CLIP_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>`;

export class PiComposer extends LitElement {
	static properties = {
		streaming: { attribute: false },
		detached: { attribute: false },
		items: { attribute: false },
		rpcOnlyDisabled: { attribute: false },
		queue: { attribute: false },
		statuses: { attribute: false },
		model: { attribute: false },
		thinking: { attribute: false },
		folder: { attribute: false },
		busy: { attribute: false },
		searchFiles: { attribute: false },
		canImages: { attribute: false },
		text: { state: true },
		cursor: { state: true },
		files: { state: true },
		attachments: { state: true },
		menuIndex: { state: true },
		menuDismissed: { state: true },
	};
	declare streaming: boolean;
	declare detached: boolean;
	declare items: SlashItem[];
	declare rpcOnlyDisabled: boolean;
	declare queue: { steering: string[]; followUp: string[] };
	declare statuses: string[];
	declare model: ModelInfo | null;
	declare thinking: ThinkingLevel | null;
	declare folder: string | null; // an unsent chat shows its folder after the model
	declare busy: boolean; // the last send is still being taken (an unsent chat starting its session)
	declare searchFiles: FileSearch | null;
	declare canImages: boolean; // the model can see images; decided at send time, so an early drop still routes right
	declare text: string;
	declare cursor: number;
	declare files: MentionEntry[];
	declare attachments: Attachment[];
	declare menuIndex: number;
	declare menuDismissed: boolean;
	private pressTimer: ReturnType<typeof setTimeout> | undefined;
	private longPressed = false;
	private fileTimer: ReturnType<typeof setTimeout> | undefined;
	private fileSearch: AbortController | undefined;
	private fileQuery: string | null = null;

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
			.opt code.path { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
			.opt span { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
			.attachments { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
			.chip.file { display: inline-flex; align-items: center; gap: 6px; border-style: solid; padding: 4px 8px; font-size: 0.78rem; color: var(--text); cursor: pointer; }
			.chip.file svg { width: 14px; height: 14px; flex: none; color: var(--text-secondary); }
			.chip.file .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 14rem; }
			.chip.file .size { color: var(--text-muted); flex: none; }
			.thumb img { width: 48px; height: 48px; object-fit: cover; border-radius: var(--radius); border: 1px solid var(--line); }
			.box { display: grid; gap: 2px; padding: 4px 0 0; }
			textarea { width: 100%; min-width: 0; border: 0; padding: 4px 0; resize: none; background: transparent; line-height: 1.45; max-height: 40vh; outline: none; }
			textarea:focus-visible { outline: none; }
			.row { display: flex; gap: 6px; align-items: center; }
			.lead { display: flex; align-items: center; min-width: 0; margin-right: auto; font-size: 0.8rem; white-space: nowrap; }
			.model { color: var(--primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
			.model b { font-weight: 500; }
			.folder { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1000 auto; }
			.icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); color: var(--text-secondary); font-size: 1.1rem; cursor: pointer; flex: none; }
			.icon svg { width: 20px; height: 20px; }
			.icon.send { color: #000; background: var(--primary); border-radius: 50%; }
			.icon.stop { color: #fff; background: var(--accent); border-radius: 50%; }
			.icon.stop svg { width: 16px; height: 16px; }
			.icon:disabled { opacity: 0.45; cursor: default; }
			.status { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 0.7rem; color: var(--text-muted); }
		`,
	];

	constructor() {
		super();
		this.streaming = false;
		this.detached = false;
		this.items = [];
		this.rpcOnlyDisabled = false;
		this.queue = { steering: [], followUp: [] };
		this.statuses = [];
		this.model = null;
		this.thinking = null;
		this.folder = null;
		this.busy = false;
		this.searchFiles = null;
		this.canImages = false;
		this.text = "";
		this.cursor = 0;
		this.files = [];
		this.attachments = [];
		this.menuIndex = 0;
		this.menuDismissed = false;
	}

	setText(text: string, cursor = text.length): void {
		this.text = text;
		this.cursor = cursor;
		this.updateComplete.then(() => {
			this.textarea?.focus();
			this.textarea?.setSelectionRange(cursor, cursor);
		});
	}

	// Put a failed message back unless the user already started typing again.
	restore(text: string, images: ImageInput[], files: FileInput[] = []): void {
		if (this.text || this.attachments.length) return;
		this.text = text;
		this.attachments = [
			...images.map((image): Attachment => ({ kind: "image", name: `image.${image.mimeType.split("/")[1] ?? "png"}`, size: Math.floor((image.data.length * 3) / 4), image })),
			...files.map((file): Attachment => ({ kind: "file", file })),
		];
	}

	private get textarea(): HTMLTextAreaElement | null {
		return this.renderRoot.querySelector("textarea");
	}

	private get mention() {
		return this.searchFiles ? mentionAt(this.text, this.cursor) : null;
	}

	private get menu(): Menu | null {
		if (this.menuDismissed) return null;
		if (this.mention) return this.files.length ? { kind: "files", items: this.files } : null;
		const q = slashQuery(this.text);
		const items = q === null ? [] : filterSlash(this.items, q);
		return items.length ? { kind: "slash", items } : null;
	}

	// Debounced, and a newer query cancels the one in flight.
	private refreshFiles(): void {
		const query = this.mention?.query ?? null;
		if (query === this.fileQuery) return;
		this.fileQuery = query;
		clearTimeout(this.fileTimer);
		this.fileSearch?.abort();
		if (query === null || !this.searchFiles) {
			this.files = [];
			return;
		}
		const search = this.searchFiles;
		const ctl = (this.fileSearch = new AbortController());
		this.fileTimer = setTimeout(() => {
			search(query, ctl.signal).then(
				(files) => {
					if (ctl.signal.aborted) return;
					this.files = files;
					this.menuIndex = 0;
				},
				() => {
					if (!ctl.signal.aborted) this.files = [];
				},
			);
		}, FILE_SEARCH_DELAY_MS);
	}

	private openSheet(sheet: "menu" | "model"): void {
		this.dispatchEvent(new CustomEvent("pi-open-sheet", { detail: sheet, bubbles: true, composed: true }));
	}

	private submit(mode: PromptMode): void {
		const text = this.text.trim();
		if (this.busy || (!text && this.attachments.length === 0)) return;
		const { images, files } = routeAttachments(this.attachments, this.canImages);
		this.dispatchEvent(new CustomEvent<SubmitDetail>("pi-submit", { detail: { text, images, files, mode }, bubbles: true, composed: true }));
		this.text = "";
		this.attachments = [];
		this.cursor = 0;
		this.menuIndex = 0;
		if (matchMedia("(pointer: coarse)").matches) this.textarea?.blur(); // put the keyboard away on a phone
	}

	private pick(menu: Menu, i: number): void {
		if (menu.kind === "slash") this.complete(menu.items[i]);
		else this.completeFile(menu.items[i]);
	}

	private completeFile(entry: MentionEntry): void {
		const m = this.mention;
		if (!m) return;
		const r = applyMention(this.text, m, entry);
		if (entry.dir) this.files = []; // the old results aren't this folder's; don't let Enter pick from them
		this.setText(r.text, r.cursor);
		this.menuIndex = 0;
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
		const ta = e.target as HTMLTextAreaElement;
		this.text = ta.value;
		this.cursor = ta.selectionStart;
		this.menuDismissed = false;
		this.menuIndex = 0;
	};

	// Arrow keys and taps move the cursor in or out of an @ token.
	private onCaret = (e: Event) => {
		const pos = (e.target as HTMLTextAreaElement).selectionStart;
		if (pos !== this.cursor) this.cursor = pos;
	};

	private onKey = (e: KeyboardEvent) => {
		const menu = this.menu;
		const count = menu?.items.length ?? 0;
		if (menu && !e.isComposing && e.keyCode !== 229) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const step = e.key === "ArrowDown" ? 1 : -1;
				this.menuIndex = (this.menuIndex + step + count) % count;
				return;
			}
			if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
				e.preventDefault();
				this.pick(menu, Math.min(this.menuIndex, count - 1));
				return;
			}
			if (e.key === "Escape") {
				this.menuDismissed = true;
				return;
			}
		}
		const onScreenKeyboard = document.documentElement.hasAttribute("data-keyboard");
		if (e.keyCode !== 229 && enterSends(e, { finePointer: matchMedia("(pointer: fine)").matches, onScreenKeyboard })) {
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
		clearTimeout(this.fileTimer);
		this.fileSearch?.abort();
		this.fileQuery = null;
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
		let files = [...(input.files ?? [])];
		input.value = "";
		if (input.dataset.kind === "image") {
			const accepted = files.filter((f) => checkImageFile(f));
			if (accepted.length < files.length) toast("Only PNG, JPEG, GIF or WebP images up to 5 MB can be attached.", "warning");
			files = accepted;
		}
		await this.addFiles(files);
	};

	// Anything picked, dropped or pasted. Images that pass the image checks stay images until send time.
	async addFiles(files: File[]): Promise<void> {
		const { ok, error } = acceptFiles(files, attachmentBytes(this.attachments));
		if (error) toast(error, "warning");
		const results = await Promise.allSettled(
			ok.map(async (f): Promise<Attachment> => {
				const data = await readAsBase64(f);
				return checkImageFile(f) ? { kind: "image", name: f.name, size: f.size, image: { mimeType: f.type, data } } : { kind: "file", file: { name: f.name, mimeType: f.type, size: f.size, data } };
			}),
		);
		const added = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
		if (added.length < ok.length) toast("A file couldn't be read.", "error");
		if (added.length) this.attachments = [...this.attachments, ...added];
	}

	private onPaste = (e: ClipboardEvent) => {
		const files = [...(e.clipboardData?.files ?? [])];
		if (!files.length) return; // plain text pastes as text
		e.preventDefault();
		void this.addFiles(files);
	};

	// Opens a file picker; the ＋ menu's attach rows call this.
	pickFiles(kind: "image" | "file"): void {
		this.renderRoot.querySelector<HTMLInputElement>(`input[type=file][data-kind=${kind}]`)?.click();
	}

	willUpdate(): void {
		this.refreshFiles();
	}

	updated(): void {
		const ta = this.textarea;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight}px`;
	}

	private renderMenu(menu: Menu) {
		const opt = (i: number, cls: string, body: unknown) =>
			html`<div id="slash-opt-${i}" role="option" aria-selected=${i === this.menuIndex ? "true" : "false"} class="opt ${i === this.menuIndex ? "on" : ""} ${cls}" @pointerdown=${(e: Event) => {
				e.preventDefault();
				this.pick(menu, i);
			}}>${body}</div>`;
		return html`<div class="menu" id="slash-menu" role="listbox" aria-label=${menu.kind === "slash" ? "Commands" : "Files"}>
			${menu.kind === "slash"
				? menu.items.map((item, i) => opt(i, item.rpcOnly && this.rpcOnlyDisabled ? "off" : "", html`<code>/${item.name}</code><span>${item.description}</span>`))
				: menu.items.map((f, i) => opt(i, "", html`<code class="path"><bdi>${f.dir ? `${f.path}/` : f.path}</bdi></code>`))}
		</div>`;
	}

	render() {
		const menu = this.menu;
		const queued = [...this.queue.steering.map((t) => ["steer", summarizeAttachments(t)]), ...this.queue.followUp.map((t) => ["follow-up", summarizeAttachments(t)])];
		return html`<div class="inner">
			${queued.length ? html`<div class="queue" aria-label="Queued messages">${queued.map(([k, t]) => html`<span class="chip"><span class="label">${k}</span> ${t}</span>`)}</div>` : nothing}
			${menu ? this.renderMenu(menu) : nothing}
			${this.attachments.length
				? html`<div class="attachments">${this.attachments.map((a, i) => {
						const remove = () => (this.attachments = this.attachments.filter((_, j) => j !== i));
						return a.kind === "image"
							? html`<button class="thumb" aria-label="Remove image" @click=${remove}><img alt="" src="data:${a.image.mimeType};base64,${a.image.data}" /></button>`
							: html`<button class="chip file" aria-label=${`Remove ${a.file.name}`} @click=${remove}>${CLIP_ICON}<span class="name">${a.file.name}</span><span class="size">${formatBytes(a.file.size)}</span></button>`;
					})}</div>`
				: nothing}
			<div class="box">
				<textarea role="combobox" aria-autocomplete="list" aria-controls="slash-menu" aria-expanded=${menu ? "true" : "false"} aria-activedescendant=${menu ? `slash-opt-${Math.min(this.menuIndex, menu.items.length - 1)}` : nothing} aria-label="Message" rows="1" placeholder=${this.detached ? "continue here" : this.streaming ? "steer pi, or hold send to queue a follow-up" : "message pi, / for commands, @ for files"} .value=${this.text} @input=${this.onInput} @keydown=${this.onKey} @keyup=${this.onCaret} @click=${this.onCaret} @paste=${this.onPaste}></textarea>
				<div class="row">
					<button class="icon" aria-label="Chat options" @click=${() => this.openSheet("menu")}>${PLUS_ICON}</button>
					<input class="sr-only" type="file" data-kind="image" accept="image/*" multiple tabindex="-1" aria-hidden="true" @change=${this.onFiles} />
					<input class="sr-only" type="file" data-kind="file" multiple tabindex="-1" aria-hidden="true" @change=${this.onFiles} />
					<div class="lead">
						<button class="model u" aria-label=${`Model ${this.model?.name ?? "not loaded"}`} @click=${() => this.openSheet("model")}>
							${this.model ? html`<b>${this.model.name}</b>${this.thinking ? ` · ${this.thinking}` : nothing}` : "model"}
						</button>
						${this.folder ? html`<span class="folder">&nbsp;· ${this.folder}</span>` : nothing}
					</div>
					${this.streaming && !this.text.trim() && !this.attachments.length
						? html`<button class="icon stop" aria-label="stop" @click=${() => this.dispatchEvent(new CustomEvent("pi-abort", { bubbles: true, composed: true }))}>${STOP_ICON}</button>`
						: html`<button class="icon send" aria-label=${this.streaming ? "steer" : "send"} ?disabled=${this.busy} aria-busy=${this.busy ? "true" : "false"} @pointerdown=${this.onPressStart} @pointerup=${this.onPressEnd} @pointerleave=${this.onPressEnd} @pointercancel=${this.onPressCancel} @click=${this.onSendClick}>${SEND_ICON}</button>`}
				</div>
			</div>
			${this.statuses.length ? html`<div class="status">${this.statuses.map((s) => html`<span>${s}</span>`)}</div>` : nothing}
		</div>`;
	}
}
customElements.define("pi-composer", PiComposer);
