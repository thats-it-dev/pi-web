import { type SVGTemplateResult, type TemplateResult, css, html, nothing, svg } from "lit";
import type { ApprovalMode, ModelInfo, ThinkingLevel } from "../../../shared/src/protocol.ts";

// The ＋ sheet ("this chat"): one row per feature. The root lists them; a step
// swaps the body for that feature's view, with a ‹ back control on top.
export type MenuStep = "root" | "folder" | "model" | "approvals";

export interface ChatMenuView {
	step: MenuStep;
	canImages: boolean;
	cwd: string; // as shown: the caller abbreviates it
	cwdFixed: boolean;
	model: string; // "name · thinking"
	approval: ApprovalMode | null;
	recentCwds: string[];
}

export interface ChatMenuHandlers {
	step(s: MenuStep): void;
	attach(): void;
	pickCwd(path: string): void;
}

export type MenuRowKey = "attach" | "folder" | "model" | "approvals";

export interface MenuRow {
	key: MenuRowKey;
	label: string;
	value: string;
	disabled: boolean;
	hint?: string;
}

export const FOLDER_FIXED_HINT = "fixed once a chat starts";

// A model's thinking levels: what pi reports for it, none when it doesn't reason.
export function thinkingLevelsFor(_m: ModelInfo | null, known: ThinkingLevel[]): ThinkingLevel[] {
	return known.length ? known : [];
}

export function menuRows(v: ChatMenuView): MenuRow[] {
	const rows: MenuRow[] = [];
	if (v.canImages) rows.push({ key: "attach", label: "attach image", value: "", disabled: false });
	rows.push(
		v.cwdFixed
			? { key: "folder", label: "folder", value: v.cwd, disabled: true, hint: FOLDER_FIXED_HINT }
			: { key: "folder", label: "folder", value: v.cwd, disabled: false },
		{ key: "model", label: "model", value: v.model, disabled: false },
		{ key: "approvals", label: "approvals", value: v.approval ?? "—", disabled: false },
	);
	return rows;
}

// Lucide icons (ISC): image-plus, folder, cpu and shield-check.
const icon = (body: SVGTemplateResult) =>
	html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS: Record<MenuRowKey, TemplateResult> = {
	attach: icon(svg`<path d="M16 5h6" /><path d="M19 2v6" /><path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /><circle cx="9" cy="9" r="2" />`),
	folder: icon(svg`<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />`),
	model: icon(svg`<rect width="16" height="16" x="4" y="4" rx="2" /><rect width="6" height="6" x="9" y="9" rx="1" /><path d="M15 2v2" /><path d="M15 20v2" /><path d="M2 15h2" /><path d="M2 9h2" /><path d="M20 15h2" /><path d="M20 9h2" /><path d="M9 2v2" /><path d="M9 20v2" />`),
	approvals: icon(svg`<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" />`),
};

const STEP_TITLES: Record<Exclude<MenuStep, "root">, string> = { folder: "folder", model: "model", approvals: "approvals" };

// The root rows, or a step's back control (plus the folder view). The model
// and approvals steps' bodies are the caller's: it appends modelPicker /
// approvalPicker after this.
export function chatMenu(v: ChatMenuView, on: ChatMenuHandlers): TemplateResult {
	if (v.step === "root") {
		return html`<div class="chat-menu">${menuRows(v).map((r) => {
			const body = html`<span class="ic">${ICONS[r.key]}</span>
				<span class="lbl">${r.label}${r.hint ? html`<small>${r.hint}</small>` : nothing}</span>
				<span class="val">${r.value}</span>
				${r.disabled ? html`<span class="chev"></span>` : html`<span class="chev" aria-hidden="true">›</span>`}`;
			if (r.disabled) return html`<div class="mrow off" aria-disabled="true">${body}</div>`;
			return html`<button class="mrow" @click=${() => (r.key === "attach" ? on.attach() : on.step(r.key))}>${body}</button>`;
		})}</div>`;
	}
	const back = html`<button class="back u" aria-label="Back" @click=${() => on.step("root")}>‹ ${STEP_TITLES[v.step]}</button>`;
	if (v.step !== "folder") return back;
	const submit = (e: Event) => {
		e.preventDefault();
		const path = String(new FormData(e.target as HTMLFormElement).get("path") ?? "").trim();
		if (path) on.pickCwd(path);
	};
	return html`${back}
		<form class="cwd" @submit=${submit}><input name="path" aria-label="Folder path" autocomplete="off" spellcheck="false" .value=${v.cwd} /></form>
		${v.recentCwds.length
			? html`<h3 class="label">recent</h3>
					<div class="recent">${v.recentCwds.map((c) => html`<button class="mrow" @click=${() => on.pickCwd(c)}><span class="lbl">${c}</span></button>`)}</div>`
			: nothing}`;
}

export const chatMenuStyles = css`
	.chat-menu, .recent { display: grid; gap: 2px; }
	.mrow { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 10px 8px; border-radius: var(--radius); min-width: 0; }
	button.mrow:hover { background: var(--panel); }
	.mrow.off { opacity: 0.55; cursor: default; }
	.mrow .ic { flex: none; display: grid; place-items: center; color: var(--text-secondary); }
	.mrow .ic svg { width: 18px; height: 18px; }
	.mrow .lbl { flex: 1; min-width: 0; display: grid; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.mrow .lbl small { font-size: 0.75rem; color: var(--text-muted); }
	.mrow .val { flex: 0 1 auto; min-width: 0; color: var(--text-secondary); font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.mrow .chev { flex: none; width: 0.8em; color: var(--text-muted); }
	.back { color: var(--text-secondary); font-size: 0.9rem; padding: 2px 0 10px; }
	form.cwd input { width: 100%; font-family: var(--font-mono); }
`;
