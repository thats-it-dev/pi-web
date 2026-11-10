// Keeps the progress panel's data live: derives to-dos, subagents and the plan path from the open
// session, and fetches the goal, plan text and background-subagent status from the hub.

import type { Goal } from "../../../shared/src/goal.ts";
import { type PlanDoc, parsePlan } from "../../../shared/src/plan.ts";
import { type LatestPr, type Progress, type SubagentChild, type Todo, deriveProgress, groupSubagents } from "../../../shared/src/progress.ts";
import type { RunReport } from "../../../shared/src/run-report.ts";
import { HubError, type HubApi } from "./api.ts";
import type { SessionStore } from "./session-store.ts";

export type Activity = "working" | "idle" | "waiting";
export interface ProgressView {
	goal: Goal | null;
	plan: (PlanDoc & { path: string }) | null;
	todos: Todo[] | null;
	subagents: { recent: SubagentChild[]; earlier: SubagentChild[] };
	pr: LatestPr | null;
	activity: Activity;
	/** The current run (since Michael's last message) and the ones before it; null until fetched. */
	runs: { current: RunReport; earlier: RunReport[]; fetchedAt: number } | null;
	empty: boolean; // nothing in any section
}

const GOAL_POLL_MS = 5000;
const CHILD_POLL_MS = 3000;
type Overlay = Pick<SubagentChild, "state" | "startedAt" | "endedAt">;
const terminal = (s: SubagentChild["state"]) => s === "done" || s === "failed" || s === "stopped";

// A plan path relative to the session's cwd when it is under it (tools may pass it absolute), so the
// same file always compares equal and the hub gets one spelling; anything else is left for the hub to judge.
export function relPlanPath(path: string, cwd: string | null | undefined): string {
	let p = path.replace(/^(\.\/)+/, "");
	const base = cwd ? cwd.replace(/\/+$/, "") : "";
	if (base && p.startsWith(`${base}/`)) p = p.slice(base.length + 1);
	return p;
}

export class ProgressStore extends EventTarget {
	private api: Pick<HubApi, "goal" | "plan" | "subagents" | "runs">;
	private session: SessionStore;
	private goal: Goal | null = null;
	private plan: (PlanDoc & { path: string }) | null = null;
	private planSrc: string | null = null;
	private planMtime: number | null = null;
	private overlay = new Map<string, Overlay>();
	private cached: ProgressView | null = null;
	private running = false;
	private wasStreaming = false;
	private planPath: string | null = null;
	private ended = new Set<string>(); // tool runs already seen finished
	private goalTimer: ReturnType<typeof setInterval> | null = null;
	private childTimer: ReturnType<typeof setInterval> | null = null;
	private prog: Progress | null = null; // deriveProgress once per session change
	private goalSeq = 0;
	private runsSeq = 0;
	private runs: ProgressView["runs"] = null;
	private planSeq = 0;
	private childSeq = 0;
	private childBusy = false;
	private childFails = 0;
	private onChange = () => {
		this.prog = null;
		this.update();
	};

	constructor(api: Pick<HubApi, "goal" | "plan" | "subagents" | "runs">, session: SessionStore) {
		super();
		this.api = api;
		this.session = session;
	}

	get view(): ProgressView {
		return (this.cached ??= this.compute());
	}

	// The plan's markdown, for showing it whole.
	get planText(): string | null {
		return this.view.plan ? this.planSrc : null;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		for (const [id, t] of Object.entries(this.session.conv.tools)) if (!t.running) this.ended.add(id);
		this.wasStreaming = this.session.conv.streaming;
		this.session.addEventListener("change", this.onChange);
		this.fetchGoal();
		this.prog = null;
		this.update();
	}

	stop(): void {
		this.running = false;
		this.goalSeq++;
		this.runsSeq++;
		this.planSeq++;
		this.childSeq++;
		this.childBusy = false;
		this.session.removeEventListener("change", this.onChange);
		this.setGoalTimer(false);
		this.setChildTimer(false);
	}

	private derived(): Progress {
		if (!this.prog) {
			const p = deriveProgress(this.session.conv, { live: this.session.status === "live" });
			this.prog = { ...p, planPath: p.planPath ? relPlanPath(p.planPath, this.cwd()) : null };
		}
		return this.prog;
	}

	private cwd(): string | null {
		return this.session.snapshot?.cwd ?? this.session.cwdHint;
	}

	// A "running" report that can't be refreshed is shown as unknown, never as running.
	private children(): SubagentChild[] {
		const stale = this.childFails >= 3 || (this.childFails > 0 && this.session.status !== "live");
		return this.derived().subagents.map((c) => {
			const o = c.background ? this.overlay.get(c.key) : undefined;
			if (!o) return c;
			return { ...c, ...o, state: stale && o.state === "running" ? "unknown" : o.state };
		});
	}

	private compute(): ProgressView {
		const { todos, planPath, pr } = this.derived();
		const { conv, snapshot } = this.session;
		const activity: Activity = snapshot && (snapshot.dialogs.length > 0 || snapshot.terminalPrompt || this.session.dialogs.length > 0) ? "waiting" : conv.streaming ? "working" : "idle";
		const subagents = groupSubagents(this.children());
		const plan = this.plan && this.plan.path === planPath ? this.plan : null;
		const runs = this.runs && this.runs.current.toolCalls > 0 ? this.runs : null;
		const empty = !this.goal && !plan && !todos?.length && !subagents.recent.length && !subagents.earlier.length && !runs && !pr;
		return { goal: this.goal, plan, todos, subagents, pr, activity, runs, empty };
	}

	private update(): void {
		if (!this.running) return;
		const { conv } = this.session;
		const { planPath } = this.derived();

		// Tool runs that ended since the last change.
		let goalTool = false;
		let planEdited = false;
		for (const [id, t] of Object.entries(conv.tools)) {
			if (t.running || this.ended.has(id)) continue;
			this.ended.add(id);
			if (t.name.startsWith("goal_")) goalTool = true;
			const p = (t.args as { path?: unknown } | undefined)?.path;
			if ((t.name === "edit" || t.name === "write") && planPath && typeof p === "string" && relPlanPath(p, this.cwd()) === planPath) planEdited = true;
			// A subagent may have ticked the plan's boxes itself.
			if (t.name === "subagent") planEdited = true;
		}
		const settled = this.wasStreaming && !conv.streaming;
		this.wasStreaming = conv.streaming;

		if (goalTool || settled) this.fetchGoal();
		this.setGoalTimer(conv.streaming);
		if (planPath !== this.planPath) {
			this.planPath = planPath;
			this.plan = null;
			this.planMtime = null;
			if (planPath) this.fetchPlan(planPath);
		} else if ((planEdited || settled) && planPath) this.fetchPlan(planPath); // bash/sed ticks show up on settle
		this.syncChildPolling();
		this.changed();
	}

	private changed(): void {
		this.cached = null;
		this.dispatchEvent(new Event("change"));
	}

	private setGoalTimer(on: boolean): void {
		// While a turn streams, the plan is polled on the goal's timer too: boxes ticked by bash or a child.
		if (on && !this.goalTimer)
			this.goalTimer = setInterval(() => {
				this.fetchGoal();
				if (this.planPath) this.fetchPlan(this.planPath);
			}, GOAL_POLL_MS);
		else if (!on && this.goalTimer) {
			clearInterval(this.goalTimer);
			this.goalTimer = null;
		}
	}

	// Background children are polled while running or unknown. In a session that isn't live, a child
	// the hub itself reports as unknown (no or bad status file) will not change, so it isn't polled.
	private syncChildPolling(): void {
		const live = this.session.status === "live";
		const wanted = (c: SubagentChild) => c.state === "running" || (c.state === "unknown" && (live || this.overlay.get(c.key)?.state !== "unknown"));
		this.setChildTimer(this.children().some((c) => c.background && wanted(c)));
	}

	private setChildTimer(on: boolean): void {
		if (on && !this.childTimer) {
			this.childTimer = setInterval(() => this.fetchChildren(), CHILD_POLL_MS);
			this.fetchChildren();
		} else if (!on && this.childTimer) {
			clearInterval(this.childTimer);
			this.childTimer = null;
		}
	}

	// The run report is read from the session file, so it moves on the goal's schedule: on start, every
	// GOAL_POLL_MS while a turn streams, and when it settles.
	private async fetchRuns(): Promise<void> {
		const n = ++this.runsSeq;
		try {
			const { runs } = await this.api.runs(this.session.id);
			if (!this.running || n !== this.runsSeq) return;
			const current = runs.at(-1);
			this.runs = current ? { current, earlier: runs.slice(0, -1).reverse(), fetchedAt: Date.now() } : null;
			this.changed();
		} catch {} // keep the last good value
	}

	private async fetchGoal(): Promise<void> {
		void this.fetchRuns();
		const n = ++this.goalSeq;
		try {
			const { goal } = await this.api.goal(this.session.id);
			if (!this.running || n !== this.goalSeq) return;
			this.goal = goal;
			this.changed();
		} catch {} // keep the last good value
	}

	private async fetchPlan(path: string): Promise<void> {
		const n = ++this.planSeq;
		try {
			const r = await this.api.plan(this.session.id, path);
			if (!this.running || n !== this.planSeq || this.planPath !== path) return;
			if (this.plan?.path === path && r.mtimeMs === this.planMtime) return; // unchanged on disk
			this.plan = { ...parsePlan(r.text), path };
			this.planSrc = r.text;
			this.planMtime = r.mtimeMs;
			this.changed();
		} catch (e) {
			if (!this.running || n !== this.planSeq || this.planPath !== path) return;
			if (e instanceof HubError && e.status === 404) {
				this.plan = null;
				this.planSrc = null;
				this.planMtime = null;
				this.changed();
			}
		}
	}

	private async fetchChildren(): Promise<void> {
		if (this.childBusy) return;
		this.childBusy = true;
		const n = ++this.childSeq;
		try {
			const { children } = await this.api.subagents(this.session.id);
			if (!this.running || n !== this.childSeq) return;
			this.childFails = 0;
			for (const c of children) {
				if (!c.background) continue;
				const prev = this.overlay.get(c.key);
				if (prev && terminal(prev.state)) {
					// A finished child never goes back, but its times may still be filled in.
					if (c.state === prev.state) this.overlay.set(c.key, { state: prev.state, startedAt: prev.startedAt ?? c.startedAt, endedAt: prev.endedAt ?? c.endedAt });
					continue;
				}
				this.overlay.set(c.key, { state: c.state, startedAt: c.startedAt, endedAt: c.endedAt });
			}
		} catch {
			if (!this.running || n !== this.childSeq) return;
			this.childFails++; // keep the last good value, but stop vouching for "running"
		} finally {
			if (n === this.childSeq) this.childBusy = false;
		}
		this.syncChildPolling();
		this.changed();
	}
}
