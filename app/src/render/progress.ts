import { type TemplateResult, css, html, nothing } from "lit";
import type { ChildState, SubagentChild, Todo } from "../../../shared/src/progress.ts";
import { formatElapsed } from "../lib/format.ts";
import type { ProgressView } from "../lib/progress-store.ts";

export interface ProgressOpts {
	now: number;
	selectedKey: string | null;
	openChild: (key: string) => void;
	openPlan: (path: string) => void;
}

const MAX_TODOS = 8;
const MAX_PLAN = 12;
const GLYPH: Record<ChildState, string> = { running: "◐", done: "✓", failed: "✕", stopped: "■", unknown: "?" };
const ACTIVITY = { working: "working", idle: "idle", waiting: "waiting on you" } as const;

const liveTodos = (todos: Todo[]) => todos.filter((t) => t.status !== "deleted");

export function badgeLabel(view: ProgressView): string | null {
	if (view.todos) {
		const list = liveTodos(view.todos);
		if (list.length) return `${list.filter((t) => t.status === "completed").length}/${list.length}`;
	}
	const running = view.subagents.recent.concat(view.subagents.earlier).filter((c) => c.state === "running").length;
	if (running) return `◐ ${running}`;
	return view.goal || view.plan ? "•" : null;
}

// At most `max` items, centred on `focus`; returns the slice and how many were left out.
function windowAround<T>(items: T[], focus: number, max: number): { shown: T[]; more: number } {
	if (items.length <= max) return { shown: items, more: 0 };
	const start = Math.min(Math.max(0, focus - Math.floor(max / 2)), items.length - max);
	return { shown: items.slice(start, start + max), more: items.length - max };
}

function goalSection(view: ProgressView) {
	const g = view.goal;
	if (!g) return nothing;
	const tone = g.status === "complete" ? "ok" : g.status === "blocked" || g.status.endsWith("_limited") ? "warn" : "";
	return html`<section>
		<h2 class="label">goal</h2>
		<p class="goal">${g.text}</p>
		<span class="pill ${tone}">${g.status.replaceAll("_", " ")}</span>
	</section>`;
}

function planSection(view: ProgressView, opts: ProgressOpts) {
	const p = view.plan;
	if (!p) return nothing;
	const { shown, more } = windowAround(p.tasks.map((t, i) => ({ t, i })), p.current ?? 0, MAX_PLAN);
	return html`<section>
		<h2 class="label">plan</h2>
		<div class="file">${p.path.split("/").pop()}</div>
		<ul>
			${shown.map(({ t, i }) => html`<li class="plan-task ${i === p.current ? "current" : ""}"><span class="txt">${t.title}</span><span class="n">${t.done}/${t.total}</span></li>`)}
		</ul>
		${more ? html`<div class="more">+${more} more</div>` : nothing}
		<button class="open-plan u" @click=${() => opts.openPlan(p.path)}>open plan</button>
	</section>`;
}

function todoSection(view: ProgressView) {
	if (!view.todos) return nothing;
	const list = liveTodos(view.todos);
	if (!list.length) return nothing;
	const done = list.filter((t) => t.status === "completed").length;
	const focus = Math.max(0, list.findIndex((t) => t.status === "in_progress"));
	const { shown, more } = windowAround(list, focus, MAX_TODOS);
	return html`<section>
		<h2 class="label">to-dos <span class="count">${done}/${list.length}</span></h2>
		<ul>
			${shown.map((t) => html`<li class="todo ${t.status}"><span class="txt">${t.status === "in_progress" ? (t.activeForm ?? t.subject) : t.subject}</span></li>`)}
		</ul>
		${more ? html`<div class="more">+${more} more</div>` : nothing}
	</section>`;
}

function childRow(c: SubagentChild, opts: ProgressOpts) {
	const elapsed = c.startedAt == null || (c.state === "unknown" && c.endedAt == null) ? "" : formatElapsed((c.endedAt ?? opts.now) - c.startedAt);
	return html`<button class="child" aria-current=${c.key === opts.selectedKey ? "true" : nothing} @click=${() => opts.openChild(c.key)}>
		<span class="glyph ${c.state}" role="img" aria-label=${c.state}>${GLYPH[c.state]}</span>
		<span class="txt">${c.agent} · ${c.task}</span>
		<span class="n">${elapsed}</span>
	</button>`;
}

function subagentSection(view: ProgressView, opts: ProgressOpts) {
	const { recent, earlier } = view.subagents;
	if (!recent.length && !earlier.length) return nothing;
	return html`<section>
		<h2 class="label">subagents</h2>
		${recent.map((c) => childRow(c, opts))}
		${earlier.length ? html`<details><summary>earlier (${earlier.length})</summary>${earlier.map((c) => childRow(c, opts))}</details>` : nothing}
	</section>`;
}

export function renderProgress(view: ProgressView, opts: ProgressOpts): TemplateResult {
	return html`<div class="progress">
		<div class="activity ${view.activity}" role="status">${ACTIVITY[view.activity]}</div>
		${goalSection(view)}${planSection(view, opts)}${todoSection(view)}${subagentSection(view, opts)}
	</div>`;
}

export const progressStyles = css`
	.progress { padding: 16px 0 calc(16px + var(--safe-bottom)); }
	.progress .activity { padding: 0 16px 4px; font-size: 0.85rem; color: var(--text-secondary); }
	.progress .activity.waiting { color: var(--accent); }
	.progress h2.label { margin: 0; padding: 12px 16px 4px; font-weight: 400; }
	.progress .count { color: var(--text-muted); font-variant-numeric: tabular-nums; margin-left: 4px; }
	.progress ul { list-style: none; margin: 0; padding: 0; }
	.progress .goal { margin: 0; padding: 4px 16px; font-size: 0.9rem; color: var(--text-primary); overflow-wrap: anywhere; }
	.progress .pill { display: inline-block; margin: 2px 16px; padding: 1px 8px; border: 1px solid var(--line); border-radius: 999px; font-size: 0.72rem; color: var(--text-secondary); }
	.progress .pill.ok { color: var(--success); border-color: var(--success); }
	.progress .pill.warn { color: var(--accent); border-color: var(--accent); }
	.progress .file { padding: 0 16px 4px; font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-secondary); }
	.progress li, .progress .child { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 5px 16px; font-size: 0.9rem; min-width: 0; color: var(--text-primary); text-align: left; }
	.progress li { border-left: 2px solid transparent; padding-left: 14px; }
	.progress .child { font: inherit; border: 0; background: none; color: inherit; text-align: left; cursor: pointer; }
	.progress .child:hover { background: var(--panel); }
	.progress .child[aria-current="true"] { background: var(--panel); box-shadow: inset 2px 0 0 var(--primary); }
	.progress .txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.progress .n { flex: none; font-size: 0.72rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
	.progress .plan-task.current { border-left-color: var(--primary); color: var(--primary); font-weight: 500; }
	.progress .todo.in_progress { color: var(--primary); font-weight: 500; }
	.progress .todo.completed { color: var(--text-muted); text-decoration: line-through; }
	.progress .glyph { flex: none; width: 1.2em; text-align: center; color: var(--text-secondary); }
	.progress .glyph.running { color: var(--primary); }
	.progress .glyph.done { color: var(--success); }
	.progress .glyph.failed { color: var(--accent); }
	.progress .more, .progress .open-plan { padding: 4px 16px; font-size: 0.72rem; color: var(--text-muted); }
	.progress .open-plan { color: var(--primary); }
	.progress details { margin-top: 2px; }
	.progress summary { cursor: pointer; padding: 5px 16px; font-size: 0.85rem; color: var(--text-secondary); }
`;
