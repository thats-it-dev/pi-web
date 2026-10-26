import { LitElement, css, html, nothing } from "lit";
import { sharedStyles, toast } from "@thatsit/kit";
import type { DefaultsInfo, ImageInput, ModelInfo, ThinkingLevel } from "../../../shared/src/protocol.ts";
import type { HubApi } from "../lib/api.ts";
import { type Draft, getDraft, handOff, resetDraft, updateDraft } from "../lib/draft.ts";
import { abbreviateCwd } from "../lib/format.ts";
import { hrefFor } from "../lib/route.ts";
import { matchModel, parseInput, slashItems } from "../lib/slash.ts";
import { type MenuStep, chatMenu, chatMenuStyles, thinkingLevelsFor } from "../render/chat-menu.ts";
import { approvalPicker, modelPicker, sheetStyles } from "../render/sheets.ts";
import type { PiComposer, SubmitDetail } from "./pi-composer.ts";
import "./pi-composer.ts";
import "./pi-header.ts";

type Sheet = "model" | "menu";
const SHEET_TITLES: Record<Sheet, string> = { model: "model", menu: "this chat" };
const FOCUSABLE = "input, textarea, select, button, [href], [tabindex]:not([tabindex='-1'])";
const SLASH_ITEMS = slashItems([]); // pi's own commands are known only once it runs

// An unsent chat: just the composer and its draft (folder, model, approvals).
// Nothing runs on the hub until the first send creates the session.
export class PiNewChat extends LitElement {
	static properties = {
		api: { attribute: false },
		home: { attribute: false },
		defaults: { state: true },
		recentCwds: { state: true },
		sheet: { state: true },
		menuStep: { state: true },
		busy: { state: true },
	};
	declare api: HubApi;
	declare home: string;
	declare defaults: DefaultsInfo | null;
	declare recentCwds: string[];
	declare sheet: Sheet | null;
	declare menuStep: MenuStep;
	declare busy: boolean;

	private sent = false; // the draft became a session: nothing left to keep
	private openSheetKey: string | null = null; // what the open sheet shows, for focus handling
	private attaching = false; // the sheet closed for the file picker: leave the keyboard down

	static styles = [
		sharedStyles,
		sheetStyles,
		chatMenuStyles,
		css`
			:host { display: flex; flex-direction: column; min-height: 0; height: 100%; }
			.empty { flex: 1; min-height: 0; display: grid; place-items: center; padding: 24px; }
			.empty p { font-family: var(--font-display); letter-spacing: 0.06em; font-size: 1.5rem; color: var(--text-secondary); margin: 0; text-align: center; }
		`,
	];

	constructor() {
		super();
		this.home = "";
		this.defaults = null;
		this.recentCwds = [];
		this.sheet = null;
		this.menuStep = "root";
		this.busy = false;
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.api
			.defaults()
			.then((d) => (this.defaults = d))
			.catch((e: Error) => toast(`Couldn't load the models: ${e.message}`, "error")); // sending still works, on the hub's default
		this.api
			.cwds()
			.then((r) => (this.recentCwds = r.cwds))
			.catch(() => {}); // the folder view works without them
	}

	disconnectedCallback(): void {
		const c = this.composer;
		if (!this.sent && c) updateDraft({ text: c.text, images: c.images }); // kept for when the user comes back
		super.disconnectedCallback();
	}

	firstUpdated(): void {
		const d = getDraft();
		const c = this.composer;
		void c?.updateComplete.then(() => c.restore(d.text, d.images));
	}

	private get composer(): PiComposer | null {
		return this.renderRoot.querySelector("pi-composer");
	}

	private get homeDir(): string {
		return this.defaults?.home || this.home;
	}

	private edit(p: Partial<Draft>): void {
		updateDraft(p);
		this.requestUpdate();
	}

	// ---- the draft's choices ----------------------------------------------------

	// The draft's model if one was picked here, else the hub's default (the last pick).
	private get choice(): { model: ModelInfo | null; thinking: ThinkingLevel | null } {
		const d = getDraft();
		const pick = d.model ? { ...d.model, thinking: d.thinking } : (this.defaults?.model ?? null);
		const model = pick ? (this.defaults?.models.find((m) => m.provider === pick.provider && m.id === pick.modelId) ?? null) : null;
		return { model, thinking: model ? (pick?.thinking ?? null) : null };
	}

	private levelsOf(m: ModelInfo): ThinkingLevel[] {
		return thinkingLevelsFor(m, this.defaults?.levels[`${m.provider}/${m.id}`] ?? []);
	}

	// Keeps the thinking level when the new model has it, else medium (pi's own default) or what it does have.
	private pickModel(m: ModelInfo): void {
		const levels = this.levelsOf(m);
		const cur = this.choice.thinking;
		const thinking = cur && levels.includes(cur) ? cur : levels.includes("medium") ? "medium" : (levels[0] ?? null);
		this.edit({ model: { provider: m.provider, modelId: m.id }, thinking });
	}

	private pickThinking(level: ThinkingLevel): void {
		const m = this.choice.model;
		if (m) this.edit({ model: { provider: m.provider, modelId: m.id }, thinking: level });
	}

	// ---- sending ----------------------------------------------------------------

	private onSubmit = (e: Event) => {
		const { text, images } = (e as CustomEvent<SubmitDetail>).detail;
		const parsed = parseInput(text);
		if (parsed.kind === "builtin" && this.runHere(parsed.name, parsed.args)) return;
		void this.start(text, images); // anything else needs pi: the session starts with it
	};

	// The commands that make sense before a session exists.
	private runHere(name: string, args: string): boolean {
		switch (name) {
			case "model": {
				const m = args && this.defaults ? matchModel(this.defaults.models, args) : null;
				if (m) this.pickModel(m);
				else {
					if (args && this.defaults) toast(`No single model matches “${args}”. Pick one from the list.`, "warning");
					this.openSheet("model");
				}
				return true;
			}
			case "thinking": {
				const m = this.choice.model;
				const level = m ? this.levelsOf(m).find((l) => l === args) : undefined;
				if (level) this.pickThinking(level);
				else this.openSheet("model");
				return true;
			}
			case "new":
				return true; // this is one
			case "resume":
				this.dispatchEvent(new CustomEvent("tk-open-nav", { bubbles: true, composed: true }));
				return true;
		}
		return false;
	}

	private async start(text: string, images: ImageInput[]): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const d = getDraft();
		const { model, thinking } = this.choice;
		try {
			const { sessionId } = await this.api.createSession({ cwd: d.cwd, ...(model ? { model: { provider: model.provider, modelId: model.id }, thinking } : {}) });
			handOff(sessionId, { text, images, approval: d.approval });
			resetDraft();
			this.sent = true;
			location.hash = hrefFor({ name: "session", id: sessionId });
		} catch (err) {
			toast((err as Error).message, "error");
			updateDraft({ text, images }); // kept even if the page was left while the hub answered
			this.composer?.restore(text, images);
		} finally {
			this.busy = false;
		}
	}

	// ---- sheets and focus ---------------------------------------------------------

	private openSheet(sheet: Sheet): void {
		this.sheet = sheet;
		this.menuStep = "root";
	}

	updated(): void {
		this.syncFocus();
	}

	// Move focus into a sheet when it opens; give it back to the composer when it closes.
	private syncFocus(): void {
		const key = this.sheet === "menu" ? `menu:${this.menuStep}` : this.sheet;
		if (key === this.openSheetKey) return;
		this.openSheetKey = key;
		if (!key) {
			const attaching = this.attaching;
			this.attaching = false;
			if (attaching && matchMedia("(pointer: coarse)").matches) return; // the keyboard would cover the file picker
			this.composer?.updateComplete.then(() => this.composer?.renderRoot.querySelector("textarea")?.focus());
			return;
		}
		const sheet = this.renderRoot.querySelector<LitElement>("tk-sheet");
		void sheet?.updateComplete.then(() => {
			const target = sheet.querySelector<HTMLElement>(FOCUSABLE) ?? sheet.renderRoot.querySelector<HTMLElement>("button");
			target?.focus();
		});
	}

	// ---- render -------------------------------------------------------------------

	render() {
		const d = getDraft();
		const { model, thinking } = this.choice;
		return html`
			<pi-header .draft=${{ contextWindow: model?.contextWindow ?? 0 }}></pi-header>
			<div class="empty"><p>what are we doing?</p></div>
			<pi-composer
				.items=${SLASH_ITEMS}
				.model=${model}
				.thinking=${thinking}
				.folder=${abbreviateCwd(d.cwd, this.homeDir)}
				.busy=${this.busy}
				@pi-submit=${this.onSubmit}
				@pi-open-sheet=${(e: CustomEvent<Sheet>) => this.openSheet(e.detail)}
			></pi-composer>
			${this.sheet ? html`<tk-sheet open heading=${SHEET_TITLES[this.sheet]} @tk-close=${() => (this.sheet = null)}>${this.sheet === "menu" ? this.renderMenu() : this.renderModels(() => (this.sheet = null))}</tk-sheet>` : nothing}
		`;
	}

	private renderModels(picked: () => void) {
		const defaults = this.defaults;
		if (!defaults) return html`<p class="hint">loading models…</p>`;
		const { model, thinking } = this.choice;
		return modelPicker(
			{ models: defaults.models, current: model, thinkingLevels: model ? this.levelsOf(model) : [], thinking },
			{
				pickModel: (m) => {
					this.pickModel(m);
					picked();
				},
				pickThinking: (l) => this.pickThinking(l),
			},
		);
	}

	private renderMenu() {
		const d = getDraft();
		const step = this.menuStep;
		const { model, thinking } = this.choice;
		const approval = d.approval ?? this.defaults?.approvalMode ?? null;
		const menu = chatMenu(
			{
				step,
				canImages: Boolean(model?.input.includes("image")),
				cwd: abbreviateCwd(d.cwd, this.homeDir),
				cwdFixed: false,
				model: model ? `${model.name}${thinking ? ` · ${thinking}` : ""}` : "—",
				approval,
				recentCwds: this.recentCwds.map((c) => abbreviateCwd(c, this.homeDir)),
			},
			{
				step: (s) => (this.menuStep = s),
				attach: () => {
					this.attaching = true;
					this.sheet = null;
					this.composer?.pickImages();
				},
				pickCwd: (path) => {
					this.edit({ cwd: path });
					this.menuStep = "root";
				},
			},
		);
		if (step === "model") return html`${menu}${this.renderModels(() => (this.menuStep = "root"))}`;
		if (step === "approvals") return html`${menu}${approval ? approvalPicker(approval, (mode) => this.edit({ approval: mode })) : html`<p class="hint">loading…</p>`}`;
		return menu;
	}
}
customElements.define("pi-new-chat", PiNewChat);
