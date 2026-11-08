import { nothing } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SubagentChild, Todo } from "../../../shared/src/progress.ts";
import type { ProgressView } from "../lib/progress-store.ts";
import { badgeLabel, renderProgress } from "./progress.ts";

const empty = (): ProgressView => ({ goal: null, plan: null, todos: null, subagents: { recent: [], earlier: [] }, activity: "idle", empty: true });
const child = (over: Partial<SubagentChild> = {}): SubagentChild => ({
	key: "t:0", toolCallId: "t", index: 0, agent: "worker", task: "do it", state: "done", background: false, turn: 0, startedAt: 1000, endedAt: 13_000, sessionFile: null, asyncDir: null, ...over,
});
const todo = (id: number, status: Todo["status"], over: Partial<Todo> = {}): Todo => ({ id, subject: `task ${id}`, status, ...over });

// vitest runs in node here (no DOM), so flatten the lit template to markup instead of rendering it.
interface Flat { html: string; text: string; fns: Array<() => void> }
function flatten(v: unknown, fns: Array<() => void>): string {
	if (v === nothing || v == null || v === false) return "";
	if (Array.isArray(v)) return v.map((x) => flatten(x, fns)).join("");
	if (typeof v === "function") return `fn:${fns.push(v as () => void) - 1}`;
	if (typeof v === "object" && "strings" in (v as object)) {
		const t = v as { strings: string[]; values: unknown[] };
		return t.strings.map((str, i) => str + (i < t.values.length ? flatten(t.values[i], fns) : "")).join("");
	}
	return String(v);
}
function mount(view: ProgressView, over: Partial<Parameters<typeof renderProgress>[1]> = {}) {
	const opts = { now: 100_000, selectedKey: null, openChild: vi.fn(), openPlan: vi.fn(), ...over };
	const fns: Array<() => void> = [];
	const html = flatten(renderProgress(view, opts), fns);
	const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
	return { f: { html, text, fns } as Flat, opts };
}
const click = (f: Flat, marker: string) => {
	const m = new RegExp(`${marker}[^>]*@click=fn:(\\d+)`).exec(f.html);
	f.fns[Number(m![1])]();
};

describe("renderProgress", () => {
	it("shows the activity and omits empty sections", () => {
		const { f } = mount(empty());
		expect(f.text).toContain("idle");
		for (const h of ["goal", "plan", "to-dos", "subagents"]) expect(f.text).not.toContain(h);
		expect(mount({ ...empty(), activity: "waiting" }).f.text).toContain("waiting on you");
		expect(mount({ ...empty(), activity: "working" }).f.text).toContain("working");
	});

	it("renders goal, plan, to-dos and subagents in order", () => {
		const { f, opts } = mount({
			...empty(), empty: false,
			goal: { text: "ship it", status: "complete", waiting: false, updatedAt: null },
			plan: { path: "docs/superpowers/plans/p.md", title: "P", tasks: [{ title: "One", done: 1, total: 2 }, { title: "Two", done: 0, total: 3 }], current: 1 },
			todos: [todo(1, "completed"), todo(2, "in_progress", { activeForm: "Doing two" })],
			subagents: { recent: [child()], earlier: [child({ key: "t:1" })] },
		});
		const idx = ["goal", "plan", "to-dos", "subagents"].map((h) => f.text.indexOf(h));
		expect(idx.every((i) => i >= 0)).toBe(true);
		expect([...idx].sort((a, b) => a - b)).toEqual(idx);
		expect(f.html).toContain("<details>");
		for (const t of ["ship it", "p.md", "1/2", "Doing two", "earlier (1)"]) expect(f.text).toContain(t);
		click(f, "open-plan");
		expect(opts.openPlan).toHaveBeenCalledWith("docs/superpowers/plans/p.md");
	});

	it("counts to-dos without deleted", () => {
		const { f } = mount({ ...empty(), empty: false, todos: [todo(1, "completed"), todo(2, "pending"), todo(3, "deleted")] });
		expect(f.text).toContain("to-dos 1/2");
		expect(f.text).not.toContain("task 3");
	});

	it("shows unknown children as ? and never as running", () => {
		const { f } = mount({ ...empty(), empty: false, subagents: { recent: [child({ state: "unknown", endedAt: null })], earlier: [] } });
		expect(f.html).toMatch(/aria-label=unknown[^>]*>\?</);
		expect(f.text).not.toContain("◐");
		expect(f.text).not.toMatch(/\d+s/);
	});

	it("opens a child on click and marks the selected one", () => {
		const { f, opts } = mount({ ...empty(), empty: false, subagents: { recent: [child({ state: "running", endedAt: null })], earlier: [] } }, { selectedKey: "t:0" });
		expect(f.html).toContain('aria-current=true');
		expect(f.text).toContain("worker · do it");
		expect(f.text).toContain("1m 39s");
		click(f, 'class="child"');
		expect(opts.openChild).toHaveBeenCalledWith("t:0");
	});

	it("shows the first plan tasks with +n more when current is null", () => {
		const tasks = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, done: 0, total: 1 }));
		const { f } = mount({ ...empty(), empty: false, plan: { path: "docs/superpowers/plans/p.md", title: null, tasks, current: null } });
		expect(f.html.match(/class="plan-task /g)!.length).toBe(12);
		expect(f.text).toContain("T0 ");
		expect(f.text).toContain("+8 more");
	});

	it("keeps the in-progress to-do visible when the list is long", () => {
		const todos = Array.from({ length: 20 }, (_, i) => todo(i, i === 15 ? "in_progress" : "pending"));
		const { f } = mount({ ...empty(), empty: false, todos });
		expect(f.text).toContain("task 15");
		expect(f.html.match(/class="todo /g)!.length).toBe(8);
		expect(f.text).toContain("+12 more");
	});
});

describe("badgeLabel", () => {
	it("covers every case, finished subagents included", () => {
		expect(badgeLabel(empty())).toBeNull();
		expect(badgeLabel({ ...empty(), empty: false, goal: { text: "g", status: "active", waiting: false, updatedAt: null } })).toBe("•");
		expect(badgeLabel({ ...empty(), subagents: { recent: [child({ state: "running" }), child({ key: "x", state: "running" }), child({ key: "y" })], earlier: [] } })).toBe("◐ 2");
		expect(badgeLabel({ ...empty(), subagents: { recent: [child()], earlier: [] } })).toBe("•");
		expect(badgeLabel({ ...empty(), subagents: { recent: [], earlier: [child({ state: "failed" })] } })).toBe("•");
		expect(badgeLabel({ ...empty(), todos: [todo(1, "completed"), todo(2, "pending"), todo(3, "deleted")] })).toBe("1/2");
	});
});
