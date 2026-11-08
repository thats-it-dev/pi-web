import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import { sharedStyles, toast } from "@thatsit/kit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AppCommand, Capabilities, CommandResult, ForkPoint, ImageInput, PromptMode, Snapshot, StreamMessage } from "../../../shared/src/protocol.ts";
import { contentText } from "../../../shared/src/reducer.ts";
import { stripTldr } from "../../../shared/src/tldr.ts";
import type { HubApi } from "../lib/api.ts";
import { takeHandoff } from "../lib/draft.ts";
import { abbreviateCwd, sessionTitle } from "../lib/format.ts";
import type { ImageLoader } from "../lib/image-loader.ts";
import type { ListStore } from "../lib/list-store.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { ProgressStore } from "../lib/progress-store.ts";
import { sessionImageLoader } from "../lib/session-images.ts";
import { hrefFor } from "../lib/route.ts";
import { SessionStore } from "../lib/session-store.ts";
import { matchModel, parseInput, slashItems } from "../lib/slash.ts";
import { openStream } from "../lib/stream.ts";
import { badgeLabel, progressStyles, renderProgress } from "../render/progress.ts";
import { markdownStyles } from "../render/messages.ts";
import { type MenuStep, chatMenu, chatMenuStyles } from "../render/chat-menu.ts";
import { type DialogAnswer, UNAVAILABLE_IN_TERMINAL, dialogSheet, forkSheet, modelSheet, settingsSheet, sheetStyles, statsSheet } from "../render/sheets.ts";
import type { FileSearch, PiComposer, SubmitDetail } from "./pi-composer.ts";
import "./pi-composer.ts";
import "./pi-header.ts";
import "./pi-messages.ts";
import "./pi-child-thread.ts";
import "./pi-progress-view.ts";

type Sheet = "model" | "stats" | "fork" | "menu" | "plan";
const SHEET_TITLES: Record<Sheet, string> = { model: "model", stats: "session", fork: "fork from…", menu: "this chat", plan: "plan" };
const WIDE = "(min-width: 1200px)"; // room for the progress column beside the chat
const EDGE = 24; // a swipe from this close to the right edge opens the progress view
const SWIPE = 60;
const FOCUSABLE = "input, textarea, select, button, [href], [tabindex]:not([tabindex='-1'])";

export class PiSession extends LitElement {
	static properties = {
		api: { attribute: false },
		list: { attribute: false },
		sessionId: { attribute: false },
		childKey: { attribute: false },
		home: { attribute: false },
		version: { state: true },
		sheet: { state: true },
		menuStep: { state: true },
		forkPoints: { state: true },
		tucked: { state: true },
		wide: { state: true },
		progressOpen: { state: true },
	};
	declare api: HubApi;
	declare list: ListStore | null;
	declare sessionId: string;
	declare childKey: string | null; // set: the chat area shows that subagent's transcript, read-only
	declare home: string;
	declare version: number;
	declare sheet: Sheet | null;
	declare menuStep: MenuStep;
	declare forkPoints: ForkPoint[];
	declare tucked: boolean;
	declare wide: boolean;
	declare progressOpen: boolean;

	store: SessionStore | null = null;
	progress: ProgressStore | null = null;
	private loader: ImageLoader | null = null; // one per session view: blob URLs live and die with it
	private stream: { close(): void } | null = null;
	private streamId: string | null = null;
	private atBottom = true;
	private lastScrollTop = 0;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private pendingPrompt: { text: string; images: ImageInput[] } | null = null; // accepted but not yet answered by pi
	private openSheetKey: string | null = null; // what the open sheet shows, for focus handling
	private mq = matchMedia(WIDE);
	private swipeFrom: { x: number; y: number } | null = null;
	private attaching = false; // the sheet closed for the file picker: leave the keyboard down

	static styles = [
		sharedStyles,
		sheetStyles,
		chatMenuStyles,
		markdownStyles,
		progressStyles,
		css`
			:host { display: flex; min-height: 0; height: 100%; }
			.chat { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
			aside { flex: none; width: 300px; border-left: 1px solid var(--line); overflow-y: auto; overscroll-behavior: contain; }
			.plan-doc { font-size: 0.9rem; }
			.scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
			.tray { border-top: 1px solid var(--line); padding: 4px 14px; font-size: 0.75rem; }
			.tray summary { cursor: pointer; font-weight: 400; }
			.tray pre { font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-secondary); white-space: pre-wrap; margin: 4px 0; max-height: 30vh; overflow: auto; }
		`,
	];

	constructor() {
		super();
		this.list = null;
		this.sessionId = "";
		this.childKey = null;
		this.home = "";
		this.version = 0;
		this.sheet = null;
		this.menuStep = "root";
		this.forkPoints = [];
		this.tucked = false;
		this.wide = this.mq.matches;
		this.progressOpen = false;
		this.addEventListener("pi-open-plan", this.onOpenPlan);
		this.addEventListener("pi-open-child", this.onOpenChild);
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.wide = this.mq.matches; // may have changed while detached
		this.mq.removeEventListener("change", this.onWide); // no double add on reconnect
		this.mq.addEventListener("change", this.onWide);
		window.addEventListener("popstate", this.onPop);
		this.addEventListener("touchstart", this.onTouchStart, { passive: true });
		this.addEventListener("touchend", this.onTouchEnd, { passive: true });
		this.addEventListener("touchcancel", this.onTouchCancel, { passive: true });
		this.syncTicker();
	}

	willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("sessionId") && this.sessionId && this.sessionId !== this.store?.id) this.open(this.sessionId);
	}

	disconnectedCallback(): void {
		this.teardown();
		this.list?.setViewing(null);
		this.stopTicker();
		this.mq.removeEventListener("change", this.onWide);
		window.removeEventListener("popstate", this.onPop);
		this.removeEventListener("touchstart", this.onTouchStart);
		this.removeEventListener("touchend", this.onTouchEnd);
		this.removeEventListener("touchcancel", this.onTouchCancel);
		super.disconnectedCallback();
	}

	// ---- lifecycle ------------------------------------------------------------

	private open(id: string): void {
		this.teardown();
		const store = new SessionStore(id);
		this.store = store;
		this.list?.setViewing(id);
		this.loader = sessionImageLoader(this.api, store);
		this.sheet = null;
		if (this.progressOpen && history.state?.piProgress) history.back(); // no orphan entry when switching sessions
		this.progressOpen = false;
		this.atBottom = true;
		this.tucked = false;
		const progress = new ProgressStore(this.api, store);
		this.progress = progress;
		progress.addEventListener("change", this.onStoreChange);
		progress.start();
		store.addEventListener("change", this.onStoreChange);
		store.addEventListener("notice", this.onNotice);
		store.addEventListener("snapshot", this.onSnapshot);
		store.addEventListener("offline", this.onOffline);
		this.loadHistory(store);
		this.connectStream(id);
	}

	private loadHistory(store: SessionStore, initial = true): void {
		this.api
			.history(store.id)
			.then((h) => store === this.store && store.setHistory(h))
			.catch((e: Error) => {
				if (store !== this.store || !initial) return; // a failed refetch keeps what's on screen
				toast(e.message, "error");
				store.setHistory({ messages: [], live: false, cwd: "" });
			});
	}

	// The process went away mid-session: the file on disk is now the truth.
	private onOffline = () => {
		if (this.store) this.loadHistory(this.store, false);
	};

	private connectStream(id: string): void {
		this.stream?.close();
		const store = this.store;
		if (!store) return;
		this.streamId = id;
		this.stream = openStream<StreamMessage>(
			this.api.streamUrl(id),
			(m) => store.apply(m),
			(s) => store.setStreamStatus(s),
		);
	}

	private teardown(): void {
		this.stream?.close();
		this.stream = null;
		this.streamId = null;
		this.loader?.dispose();
		this.loader = null;
		this.progress?.removeEventListener("change", this.onStoreChange);
		this.progress?.stop();
		this.progress = null;
		const s = this.store;
		if (!s) return;
		s.removeEventListener("change", this.onStoreChange);
		s.removeEventListener("notice", this.onNotice);
		s.removeEventListener("snapshot", this.onSnapshot);
		s.removeEventListener("offline", this.onOffline);
	}

	private onStoreChange = () => {
		this.version++;
		this.syncTicker();
	};

	// Re-render once a second while a dialog with a timeout shows its countdown, or while the progress panel
	// shows a running subagent's elapsed time.
	private syncTicker(): void {
		const counting = Boolean(this.store?.dialogs[0]?.timeout) || this.progressTicks();
		if (counting && !this.ticker) this.ticker = setInterval(() => this.requestUpdate(), 1000);
		if (!counting) this.stopTicker();
	}

	private progressTicks(): boolean {
		const v = this.progress?.view;
		if (!v || !(this.wide || this.progressOpen)) return false;
		return v.subagents.recent.concat(v.subagents.earlier).some((c) => c.state === "running");
	}

	private stopTicker(): void {
		clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private onNotice = (e: Event) => {
		const m = (e as CustomEvent<StreamMessage>).detail;
		if (m.type === "notify") toast(m.message, m.level);
		else if (m.type === "command_error") {
			toast(m.error, "error");
			const p = this.pendingPrompt;
			if (m.command === "prompt" && p) {
				this.pendingPrompt = null;
				this.composer?.restore(p.text, p.images); // a no-op if the composer has new text
			}
		}
		else if (m.type === "error") toast(m.message, "error");
		else if (m.type === "editor_text") this.composer?.setText(m.text);
	};

	// Fork, clone and new move this pi process to another session id. The hub
	// only follows the new id within one connection, so reopen under it.
	private onSnapshot = () => {
		void this.sendHandoff();
		const id = this.store?.id;
		if (!id || id === this.streamId) return;
		history.replaceState(null, "", hrefFor({ name: "session", id }));
		this.connectStream(id);
		this.dispatchEvent(new CustomEvent("pi-route-replaced", { detail: { name: "session", id }, bubbles: true, composed: true }));
	};

	// ---- commands -------------------------------------------------------------

	private get composer(): PiComposer | null {
		return this.renderRoot.querySelector("pi-composer");
	}

	private async run(cmd: AppCommand): Promise<CommandResult | null> {
		const s = this.store;
		if (!s) return null;
		s.markStarting();
		try {
			const r = await this.api.command(s.id, cmd);
			if (!r.result.ok) {
				if (r.result.error) toast(r.result.error, "error");
				s.cancelStarting();
			}
			return r.result;
		} catch (e) {
			toast((e as Error).message, "error");
			s.cancelStarting();
			return null;
		}
	}

	private async ok(cmd: AppCommand): Promise<boolean> {
		return Boolean((await this.run(cmd))?.ok);
	}

	// Toasts and returns true when the terminal-owned session can't do this.
	private unavailable(cap: Exclude<keyof Capabilities, "dialogs">): boolean {
		const caps = this.store?.snapshot?.capabilities;
		if (!caps || caps[cap]) return false;
		toast(UNAVAILABLE_IN_TERMINAL, "warning");
		return true;
	}

	// The first message of a chat started from the new-chat page, sent once pi is up.
	private async sendHandoff(): Promise<void> {
		const s = this.store;
		const msg = s?.snapshot ? takeHandoff(s.id) : null;
		if (!s?.snapshot || !msg) return;
		if (msg.approval && msg.approval !== s.snapshot.approvalMode) await this.run({ type: "set_approval", mode: msg.approval });
		await this.send(msg.text, msg.images, "send");
	}

	private onSubmit = (e: Event) => {
		const { text, images, mode } = (e as CustomEvent<SubmitDetail>).detail;
		void this.send(text, images, mode);
	};

	// Failures put the text and images back in the composer.
	private async send(text: string, images: ImageInput[], mode: PromptMode): Promise<void> {
		this.atBottom = true;
		const parsed = parseInput(text);
		let ok: boolean;
		if (parsed.kind === "bash") ok = !this.unavailable("bash") && (await this.ok({ type: "bash", command: parsed.command, excludeFromContext: parsed.excludeFromContext }));
		else if (parsed.kind === "builtin") ok = await this.runBuiltin(parsed.name, parsed.args);
		else {
			const streaming = this.store?.conv.streaming ?? false;
			this.pendingPrompt = null;
			const r = await this.run({ type: "prompt", text: parsed.text, images: images.length ? images : undefined, mode: streaming ? mode : "send" });
			ok = Boolean(r?.ok);
			if (r?.pending) this.pendingPrompt = { text, images }; // may still fail later as a command_error
		}
		if (!ok) this.composer?.restore(text, images);
	}

	private onAbort = () => void this.run({ type: "abort" });

	private searchFiles: FileSearch = async (q, signal) => {
		const s = this.store;
		return s ? (await this.api.files(s.id, q, signal)).files : [];
	};

	private async runBuiltin(name: string, args: string): Promise<boolean> {
		const snap = this.store?.snapshot ?? null;
		switch (name) {
			case "model": {
				const m = args && snap ? matchModel(snap.models, args) : null;
				if (m) return this.ok({ type: "set_model", provider: m.provider, modelId: m.id });
				if (args && snap) toast(`No single model matches “${args}”. Pick one from the list.`, "warning");
				this.openSheet("model");
				return true;
			}
			case "thinking": {
				const level = snap?.thinkingLevels.find((l) => l === args);
				if (level) return this.ok({ type: "set_thinking", level });
				this.openSheet("model");
				return true;
			}
			case "compact":
				return this.ok({ type: "compact", instructions: args || undefined });
			case "name":
				if (args) return this.ok({ type: "rename", name: args });
				toast(snap?.state.sessionName ? `This session is named “${snap.state.sessionName}”.` : "This session has no name yet. Type /name and a name to set one.");
				return true;
			case "session":
				this.openSheet("stats");
				return true;
			case "new":
				location.hash = hrefFor({ name: "new" });
				return true;
			case "resume":
				this.dispatchEvent(new CustomEvent("tk-open-nav", { bubbles: true, composed: true }));
				return true;
			case "copy":
				await this.copyLastReply();
				return true;
			case "fork": {
				if (this.unavailable("fork")) return false;
				const r = await this.run({ type: "get_fork_points" });
				if (!r?.ok) return false;
				this.forkPoints = (r.data as { messages: ForkPoint[] }).messages;
				this.openSheet("fork");
				return true;
			}
			case "clone":
				return !this.unavailable("clone") && this.ok({ type: "clone" });
			case "export": {
				if (this.unavailable("export")) return false;
				const r = await this.run({ type: "export" });
				const file = (r?.data as { name?: string } | undefined)?.name;
				if (!file) return false;
				await this.api.downloadExport(file).catch((e: Error) => toast(e.message, "error"));
				return true;
			}
		}
		return false;
	}

	private async copyLastReply(): Promise<void> {
		const last = this.store?.conv.messages.findLast((m) => m.role === "assistant");
		const text = last ? stripTldr(contentText(last.content)).trim() : ""; // without the TL;DR line
		if (!text) {
			toast("There's no reply to copy yet.");
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			toast("Copied the last reply.");
		} catch {
			toast("The browser blocked clipboard access.", "error");
		}
	}

	private openSheet(sheet: Sheet): void {
		this.sheet = sheet;
		this.menuStep = "root";
		if (!this.store?.snapshot) void this.run({ type: "attach" }); // models and stats need a running pi
	}

	private answer(id: string, a: DialogAnswer): void {
		const s = this.store;
		if (!s) return;
		s.dialogs = s.dialogs.filter((d) => d.id !== id);
		this.version++;
		this.syncTicker();
		void this.run({ type: "dialog_response", id, ...a });
	}

	// ---- progress panel -------------------------------------------------------

	private onWide = () => {
		this.wide = this.mq.matches;
		if (this.wide) this.progressOpen = false; // the column shows it now
		this.syncTicker();
	};

	private openProgress(): void {
		if (this.progressOpen || this.wide) return;
		history.pushState({ piProgress: true }, "");
		this.progressOpen = true;
		this.syncTicker();
	}

	private closeProgress = () => {
		if (!this.progressOpen) return;
		if (history.state?.piProgress) history.back(); // onPop closes it
		else this.progressOpen = false;
		this.syncTicker();
	};

	private onPop = () => {
		if (!this.progressOpen) return;
		this.progressOpen = false;
		this.syncTicker();
	};

	// A swipe that starts at the right edge and travels left opens the progress view.
	private onTouchStart = (e: TouchEvent) => {
		const t = e.touches[0];
		this.swipeFrom = e.touches.length === 1 && t && window.innerWidth - t.clientX <= EDGE ? { x: t.clientX, y: t.clientY } : null;
	};

	private onTouchCancel = () => {
		this.swipeFrom = null;
	};

	private onTouchEnd = (e: TouchEvent) => {
		const from = this.swipeFrom;
		this.swipeFrom = null;
		const t = e.changedTouches[0];
		if (!from || !t || this.wide || !this.progress || badgeLabel(this.progress.view) === null) return;
		const dx = t.clientX - from.x;
		if (dx <= -SWIPE && Math.abs(t.clientY - from.y) < Math.abs(dx)) this.openProgress();
	};

	// A session has one plan (the store tracks the latest plan path), so the text comes from the store, not the event's path.
	private onOpenPlan = () => {
		if (this.progress?.planText != null) this.sheet = "plan";
	};

	// On the phone the progress view sits on a history entry of its own. Replace that entry with the thread's,
	// so Back from the thread lands on the parent chat, not on the progress view.
	private onOpenChild = (e: Event) => {
		const key = (e as CustomEvent<string>).detail;
		const href = hrefFor({ name: "subagent", id: this.sessionId, key });
		if (this.progressOpen && history.state?.piProgress) {
			this.progressOpen = false;
			location.replace(href);
		} else {
			this.progressOpen = false;
			location.hash = href;
		}
		this.syncTicker();
	};

	private emit(type: string, detail: unknown): void {
		this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
	}

	private renderProgressPanel() {
		const progress = this.progress;
		return progress && !progress.view.empty ? progress : null;
	}

	// ---- scrolling and focus --------------------------------------------------

	private onScroll = (e: Event) => {
		const el = e.target as HTMLElement;
		this.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		const delta = el.scrollTop - this.lastScrollTop;
		if (Math.abs(delta) > 8) this.tucked = delta > 0 && el.scrollTop > 60 && !this.atBottom;
		this.lastScrollTop = el.scrollTop;
	};

	updated(changed: PropertyValues<this>): void {
		if (changed.has("progressOpen") && changed.get("progressOpen") === true && !this.progressOpen)
			this.renderRoot.querySelector<LitElement>("pi-header")?.renderRoot.querySelector<HTMLElement>(".badge")?.focus();
		if (this.atBottom) {
			const messages = this.renderRoot.querySelector<LitElement>("pi-messages");
			void messages?.updateComplete.then(() => {
				const el = this.renderRoot.querySelector<HTMLElement>(".scroll");
				if (el && this.atBottom) el.scrollTop = el.scrollHeight;
			});
		}
		this.syncFocus();
	}

	// Move focus into a sheet when it opens; give it back to the composer when it closes.
	private syncFocus(): void {
		const dialog = this.store?.dialogs[0];
		const key = dialog ? `dialog:${dialog.id}` : this.sheet === "menu" ? `menu:${this.menuStep}` : this.sheet;
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

	// ---- render ---------------------------------------------------------------

	render() {
		const s = this.store;
		if (!s) return nothing;
		const snap = s.snapshot;
		const firstPrompt = s.conv.messages.find((m) => m.role === "user");
		const heading = sessionTitle({ name: snap?.state.sessionName || s.nameHint, firstPrompt: firstPrompt ? contentText(firstPrompt.content) : null });
		const cwd = snap?.cwd ?? s.cwdHint;
		const statuses = [cwd ? abbreviateCwd(cwd, this.home) : null, ...Object.values(snap?.statuses ?? {})].filter((x): x is string => Boolean(x));
		const dialog = s.dialogs[0];
		const progress = this.renderProgressPanel();
		const label = progress && !this.wide ? badgeLabel(progress.view) : null;
		const now = Date.now();
		const opts = (selectedKey: string | null) => ({
			now,
			selectedKey,
			openChild: (key: string) => this.emit("pi-open-child", key),
			openPlan: (path: string) => this.emit("pi-open-plan", path),
		});
		return html`
			<div class="chat">
				${this.childKey ? nothing : html`<pi-header .store=${s} .version=${this.version} .heading=${heading} .badge=${label} ?tucked=${this.tucked} @pi-open-sheet=${(e: CustomEvent<Sheet>) => this.openSheet(e.detail)} @pi-open-progress=${() => this.openProgress()}></pi-header>`}
				${this.childKey
					? html`<pi-child-thread .api=${this.api} .sessionId=${this.sessionId} .childKey=${this.childKey} .heading=${heading} .live=${s.status === "live"}></pi-child-thread>`
					: html`<div class="scroll" @scroll=${this.onScroll}>
						<pi-messages .conv=${s.conv} .version=${this.version} .loader=${this.loader}></pi-messages>
					</div>
					${this.renderTray(snap)}
					<pi-composer
					.streaming=${s.conv.streaming}
					.detached=${s.status === "history"}
					.items=${slashItems(snap?.commands ?? [])}
					.rpcOnlyDisabled=${snap?.handleKind === "bridge"}
					.queue=${s.conv.queue}
					.statuses=${statuses}
					.model=${snap?.state.model ?? null}
					.thinking=${snap?.state.thinkingLevel ?? null}
					.searchFiles=${this.searchFiles}
					@pi-submit=${this.onSubmit}
					@pi-abort=${this.onAbort}
					@pi-open-sheet=${(e: CustomEvent<Sheet>) => this.openSheet(e.detail)}
				></pi-composer>`}
			</div>
			${progress && this.wide ? html`<aside aria-label="Progress">${renderProgress(progress.view, opts(this.childKey))}</aside>` : nothing}
			${progress && this.progressOpen && !this.wide
				? html`<pi-progress-view .view=${progress.view} .now=${now} .selectedKey=${this.childKey} .modal=${this.sheet !== null || s.dialogs.length > 0} @pi-close-progress=${this.closeProgress}></pi-progress-view>`
				: nothing}
			${dialog
				? html`<tk-sheet open heading=${dialog.title || "pi needs an answer"} @tk-close=${() => this.answer(dialog.id, { cancelled: true })}>
						${dialogSheet(dialog, s.dialogSeenAt.get(dialog.id) ?? Date.now(), (a) => this.answer(dialog.id, a))}
					</tk-sheet>`
				: this.sheet
					? html`<tk-sheet open heading=${SHEET_TITLES[this.sheet]} @tk-close=${() => (this.sheet = null)}>${this.renderSheet(this.sheet, snap)}</tk-sheet>`
					: nothing}
		`;
	}

	private renderSheet(sheet: Sheet, snap: Snapshot | null) {
		if (sheet === "plan") return html`<div class="md plan-doc">${unsafeHTML(renderMarkdown(this.progress?.planText ?? ""))}</div>`;
		if (sheet === "fork")
			return forkSheet(this.forkPoints, (p) => {
				this.sheet = null;
				void this.run({ type: "fork", entryId: p.entryId });
			});
		if (!snap) return html`<p class="hint">starting pi…</p>`;
		if (sheet === "menu") return this.renderMenu(snap);
		if (sheet === "stats") return statsSheet(snap, this.home, this.store?.live.speed() ?? null);
		return modelSheet(snap, {
			pickModel: (m) => {
				this.sheet = null;
				void this.run({ type: "set_model", provider: m.provider, modelId: m.id });
			},
			pickThinking: (level) => void this.run({ type: "set_thinking", level }),
		});
	}

	private renderMenu(snap: Snapshot) {
		const step = this.menuStep;
		const model = snap.state.model;
		const menu = chatMenu(
			{
				step,
				canImages: Boolean(model?.input.includes("image")),
				cwd: abbreviateCwd(snap.cwd, this.home),
				cwdFixed: true, // a running session's folder can't change
				model: model ? `${model.name} · ${snap.state.thinkingLevel}` : "—",
				approval: snap.capabilities.dialogs === "terminal" ? null : snap.approvalMode,
				recentCwds: [],
			},
			{
				step: (s) => (this.menuStep = s),
				attach: () => {
					this.attaching = true;
					this.sheet = null;
					this.composer?.pickImages();
				},
				pickCwd: () => {},
			},
		);
		if (step === "model")
			return html`${menu}${modelSheet(snap, {
				pickModel: (m) => {
					this.menuStep = "root";
					void this.run({ type: "set_model", provider: m.provider, modelId: m.id });
				},
				pickThinking: (level) => void this.run({ type: "set_thinking", level }),
			})}`;
		if (step === "approvals") return html`${menu}${settingsSheet(snap, (mode) => void this.run({ type: "set_approval", mode }))}`;
		return menu;
	}

	private renderTray(snap: Snapshot | null) {
		const widgets = Object.entries(snap?.widgets ?? {});
		if (!widgets.length) return nothing;
		return html`<details class="tray"><summary class="label">extensions (${widgets.length})</summary>${widgets.map(([key, w]) => html`<pre title=${key}>${w.lines.join("\n")}</pre>`)}</details>`;
	}
}
customElements.define("pi-session", PiSession);
