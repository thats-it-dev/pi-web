import { css, html, nothing } from "lit";
import { APPROVAL_MODES, type ApprovalMode, type Dialog, type ForkPoint, type ModelInfo, type Snapshot, type ThinkingLevel } from "../../../shared/src/protocol.ts";
import { abbreviateCwd, formatCost, formatTokens } from "../lib/format.ts";
import { type Speed, speedLabel } from "../lib/live-stats.ts";

export const UNAVAILABLE_IN_TERMINAL = "Not available while open in the terminal.";

export type DialogAnswer = { value?: string; confirmed?: boolean; cancelled?: boolean };

export function modelSheet(snap: Snapshot, on: { pickModel(m: ModelInfo): void; pickThinking(l: ThinkingLevel): void }) {
	const cur = snap.state.model;
	return html`
		<div class="models" role="listbox" aria-label="Models">
			${snap.models.map((m) => {
				const selected = cur?.provider === m.provider && cur?.id === m.id;
				return html`<button role="option" aria-selected=${selected ? "true" : "false"} class="model ${selected ? "on" : ""}" @click=${() => on.pickModel(m)}>
					<span class="name">${m.name}</span>
					<span class="meta">${m.provider} · ${formatTokens(m.contextWindow)} context${m.input.includes("image") ? " · images" : ""}${m.reasoning ? " · thinking" : ""}</span>
				</button>`;
			})}
		</div>
		${snap.thinkingLevels.length > 1
			? html`<h3 class="label">thinking</h3>
					<div class="seg" role="radiogroup" aria-label="Thinking level">
						${snap.thinkingLevels.map(
							(l) => html`<button role="radio" aria-checked=${snap.state.thinkingLevel === l ? "true" : "false"} class=${snap.state.thinkingLevel === l ? "on" : ""} @click=${() => on.pickThinking(l)}>${l}</button>`,
						)}
					</div>`
			: html`<p class="hint">${cur?.name ?? "This model"} doesn't support thinking levels.</p>`}
	`;
}

const APPROVAL_HINTS: Record<ApprovalMode, string> = {
	auto: "pi runs every tool call without asking.",
	semi: "pi runs reads, searches, writes and edits inside this folder, and read-only shell commands, without asking. Everything else asks here.",
	manual: "every tool call your permission extension flags asks here.",
};

export function settingsSheet(snap: Snapshot, pickApproval: (m: ApprovalMode) => void) {
	if (snap.capabilities.dialogs === "terminal") return html`<p class="hint">This pi is open in a terminal, which answers its own permission prompts.</p>`;
	const cur = snap.approvalMode;
	return html`
		<h3 class="label">approvals</h3>
		<div class="seg" role="radiogroup" aria-label="Approval mode">
			${APPROVAL_MODES.map((m) => html`<button role="radio" aria-checked=${cur === m ? "true" : "false"} class=${cur === m ? "on" : ""} @click=${() => pickApproval(m)}>${m}</button>`)}
		</div>
		<p class="hint">${APPROVAL_HINTS[cur]}</p>
	`;
}

export function statsSheet(snap: Snapshot, home: string, speed: Speed | null) {
	const st = snap.stats;
	const ctx = st?.contextUsage;
	const t = st?.tokens;
	const rows: Array<[string, string]> = [
		["context", ctx ? `${ctx.tokens == null ? "—" : formatTokens(ctx.tokens)} of ${formatTokens(ctx.contextWindow)}${ctx.percent != null ? ` (${Math.round(ctx.percent)}%)` : ""}` : "—"],
		["model", snap.state.model ? `${snap.state.model.name} · ${snap.state.thinkingLevel}` : "—"],
		["messages", st ? `${st.userMessages} prompts · ${st.assistantMessages} replies · ${st.toolCalls} tool calls` : "—"],
		["tokens in", t ? formatTokens(t.input) : "—"],
		["tokens out", t ? formatTokens(t.output) : "—"],
		["cache read", t ? formatTokens(t.cacheRead) : "—"],
		["cache write", t ? formatTokens(t.cacheWrite) : "—"],
		["total", t ? formatTokens(t.total) : "—"],
		["cost", st?.cost ? formatCost(st.cost) : "$0"],
		["speed", speed ? speedLabel(speed) : "—"],
		["folder", abbreviateCwd(snap.cwd, home)],
		["session file", snap.sessionFile ?? "not written yet"],
		["session id", snap.sessionId],
		["running as", snap.handleKind === "rpc" ? "headless pi on spark" : "pi in a terminal"],
	];
	return html`<dl class="stats">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

export function dialogSheet(d: Dialog, seenAt: number, respond: (a: DialogAnswer) => void) {
	const left = d.timeout ? Math.max(0, Math.round((seenAt + d.timeout - Date.now()) / 1000)) : null;
	const submitValue = (e: Event) => {
		e.preventDefault();
		respond({ value: String(new FormData(e.target as HTMLFormElement).get("value") ?? "") });
	};
	return html`
		${d.message ? html`<p class="msg">${d.message}</p>` : nothing}
		${d.method === "select" ? html`<div class="opts">${(d.options ?? []).map((o) => html`<button class="btn ghost opt" @click=${() => respond({ value: o })}>${o}</button>`)}</div>` : nothing}
		${d.method === "confirm"
			? html`<div class="row"><button class="btn" @click=${() => respond({ confirmed: true })}>yes</button><button class="btn ghost" @click=${() => respond({ confirmed: false })}>no</button></div>`
			: nothing}
		${d.method === "input"
			? html`<form class="answer" @submit=${submitValue}><input name="value" aria-label=${d.title} placeholder=${d.placeholder ?? ""} /><button class="btn">submit</button></form>`
			: nothing}
		${d.method === "editor"
			? html`<form class="answer" @submit=${submitValue}><textarea name="value" rows="10" aria-label=${d.title} .value=${d.prefill ?? ""}></textarea><button class="btn">submit</button></form>`
			: nothing}
		<div class="foot">
			${left != null ? html`<span class="hint">times out in ${left}s</span>` : html`<span></span>`}
			<button class="dismiss u" @click=${() => respond({ cancelled: true })}>dismiss</button>
		</div>
	`;
}

export function forkSheet(points: ForkPoint[], onFork: (p: ForkPoint) => void) {
	if (!points.length) return html`<p class="hint">There are no earlier messages to fork from yet.</p>`;
	return html`<p class="hint">Start a new session from one of your earlier messages.</p>
		<div class="forks">${points.map((p) => html`<button class="fork" @click=${() => onFork(p)}>${p.text.slice(0, 240)}</button>`)}</div>`;
}

export const sheetStyles = css`
	.models { display: grid; gap: 2px; margin-bottom: 14px; }
	.model { display: grid; text-align: left; padding: 8px 10px; border-left: 2px solid transparent; border-radius: var(--radius); }
	.model:hover { background: var(--panel); }
	.model.on { border-left-color: var(--primary); background: var(--panel); }
	.model .name { font-weight: 500; }
	.model .meta { font-size: 0.75rem; color: var(--text-secondary); }
	h3.label { margin: 6px 0; font-weight: 400; }
	.seg { flex-wrap: wrap; }
	.seg button { padding: 5px 12px; font-size: 0.85rem; }
	.hint { color: var(--text-secondary); font-size: 0.85rem; }
	dl.stats { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 0; font-size: 0.85rem; }
	dl.stats dt { font-family: var(--font-display); color: var(--text-muted); letter-spacing: 0.04em; }
	dl.stats dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
	.msg { white-space: pre-wrap; margin-top: 0; }
	.opts { display: grid; gap: 6px; }
	.opt { justify-content: flex-start; text-align: left; }
	.row { display: flex; gap: 8px; }
	form.answer { display: grid; gap: 8px; }
	form.answer textarea { width: 100%; font-family: var(--font-mono); }
	.foot { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; }
	.dismiss { color: var(--text-muted); font-size: 0.85rem; }
	.forks { display: grid; gap: 6px; }
	.fork { text-align: left; border-left: 3px solid var(--primary); padding: 6px 10px; font-family: var(--font-quote); background: var(--panel); border-radius: var(--radius); overflow-wrap: anywhere; }
`;
