import { nothing } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SubagentChild, Todo } from "../../../shared/src/progress.ts";
import type { RunReport } from "../../../shared/src/run-report.ts";
import type { ProgressView } from "../lib/progress-store.ts";
import { badgeLabel, renderProgress } from "./progress.ts";

const empty = (): ProgressView => ({ goal: null, plan: null, todos: null, subagents: { recent: [], earlier: [] }, pr: null, activity: "idle", runs: null, empty: true });
const child = (over: Partial<SubagentChild> = {}): SubagentChild => ({
	key: "t:0", toolCallId: "t", index: 0, agent: "worker", task: "do it", state: "done", background: false, turn: 0, startedAt: 1000, endedAt: 13_000, sessionFile: null, asyncDir: null, runId: null, ...over,
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
		expect(badgeLabel({ ...empty(), todos: [todo(1, "completed"), todo(2, "pending"), todo(3, "deleted")] })).toBe("•"); // no count
		expect(badgeLabel({ ...empty(), todos: [todo(3, "deleted")] })).toBeNull();
		expect(badgeLabel({ ...empty(), todos: [todo(1, "pending")], subagents: { recent: [child({ state: "running" })], earlier: [] } })).toBe("◐ 1");
	});

	it("a waiting goal gets a waiting pill next to its status", () => {
		const g = { text: "ship it", status: "active" as const, waiting: true, updatedAt: null };
		const { f } = mount({ ...empty(), empty: false, goal: g });
		expect(f.html).toMatch(/pill [^"]*">active<\/span><span class="pill waiting">waiting<\/span>/);
		expect(mount({ ...empty(), empty: false, goal: { ...g, waiting: false } }).f.html).not.toContain("pill waiting");
	});

	it("a plan with no step ticked says so and highlights no task", () => {
		const plan = { path: "docs/superpowers/plans/p.md", title: "P", tasks: [{ title: "One", done: 0, total: 2 }, { title: "Two", done: 0, total: 3 }], current: null };
		const { f } = mount({ ...empty(), empty: false, plan });
		expect(f.text).toContain("no steps ticked yet");
		expect(f.html).not.toContain("plan-task current");
		const ticked = mount({ ...empty(), empty: false, plan: { ...plan, tasks: [{ title: "One", done: 1, total: 2 }, plan.tasks[1]], current: 0 } }).f;
		expect(ticked.text).not.toContain("no steps ticked yet");
		expect(ticked.html).toContain("plan-task current");
	});
});

describe("run section", () => {
	const run = (over: Partial<RunReport> = {}): RunReport => ({
		label: "Make keeb teach like keybr", startedAt: 0, elapsedMs: 5_886_000, modelMs: 4_850_000, toolMs: 762_000, toolCalls: 298,
		rejected: 24, rejectedBy: { "edit retries": 14, "guard blocks": 3, "failed commands": 2, other: 5 }, nudges: { stall: 2 }, compactions: [251_325], reviewedAt: null, ...over,
	});
	const withRuns = (current: RunReport, extra: Partial<ProgressView> = {}): ProgressView => ({ ...empty(), empty: false, runs: { current, earlier: [run({ label: "earlier one", elapsedMs: 65_000 })], fetchedAt: 100_000 }, ...extra });

	it("shows the time split, counts, nudges, compactions and reviewer status", () => {
		const { f } = mount(withRuns(run()));
		expect(f.text).toContain("run 1h 38m");
		expect(f.text).toContain("model 1h 20m");
		expect(f.text).toContain("tools 12m 42s");
		expect(f.text).toContain("tool calls 298");
		expect(f.text).toContain("rejected 24 edit retries 14 guard blocks 3 failed commands 2 other 5");
		expect(f.text).toContain("nudges 2 stall");
		expect(f.text).toContain("compactions 1 · at 251k");
		expect(f.text).toContain("reviewer not yet");
		expect(f.text).toContain("earlier runs (1)");
		expect(f.text).toContain("earlier one 1m 5s");
	});

	it("a working run keeps counting between fetches; an idle one does not", () => {
		const r = run({ elapsedMs: 60_000, modelMs: 50_000, toolMs: 10_000 });
		expect(mount(withRuns(r, { activity: "working" }), { now: 130_000 }).f.text).toContain("run 1m 30s");
		expect(mount(withRuns(r, { activity: "idle" }), { now: 130_000 }).f.text).toContain("run 1m 0s");
	});

	it("no runs, no section", () => {
		expect(mount({ ...empty(), empty: false, todos: [todo(1, "pending")] }).f.text).not.toContain("tool calls");
	});
});

describe("pr section", () => {
	const pr = (over: Partial<NonNullable<ProgressView["pr"]>> = {}): ProgressView => ({
		...empty(), empty: false,
		pr: { url: "https://gh/o/r/pull/7", number: 7, title: "Add thing", ci: "none", preview: null, gatewayPreview: null, reason: null, ...over },
	});
	it("renders nothing without a PR", () => {
		expect(mount(empty()).f.html).not.toContain('<h2 class="label">pr');
	});
	it("links the PR and shows nothing more when ci is none", () => {
		const { f } = mount(pr());
		expect(f.html).toContain('<h2 class="label">pr</h2>');
		expect(f.html).toMatch(/href=https:\/\/gh\/o\/r\/pull\/7 target="_blank" rel="noopener"/);
		expect(f.text).toContain("#7 · Add thing");
		expect(f.text).not.toContain("CI");
		expect(badgeLabel(pr())).toBe("•");
	});
	it("passed shows the preview links", () => {
		const { f } = mount(pr({ ci: "passed", preview: "https://p.example", gatewayPreview: "https://g.example" }));
		expect(f.html).toContain("href=https://p.example");
		expect(f.html).toContain("href=https://g.example");
		expect(f.text).toContain("preview");
		expect(f.text).toContain("gateway preview");
		expect(mount(pr({ ci: "passed", preview: "https://p.example" })).f.text).not.toContain("gateway");
	});
	it("running, failed and lost", () => {
		expect(mount(pr({ ci: "running" })).f.text).toContain("CI running…");
		expect(mount(pr({ ci: "failed", reason: "checks failed" })).f.text).toContain("CI failed: checks failed");
		expect(mount(pr({ ci: "lost" })).f.text).toContain("CI result lost");
	});
	it("sits before subagents", () => {
		const { f } = mount({ ...pr(), subagents: { recent: [child()], earlier: [] } });
		expect(f.html.indexOf('class="label">pr<')).toBeLessThan(f.html.indexOf(">subagents<"));
	});
});
