// The session's /goal state, from the `goal-state` custom entries pi appends.

export type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
export interface Goal { text: string; status: GoalStatus; waiting: boolean; updatedAt: number | null }

const STATUSES = new Set<string>(["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"]);

function parseGoal(data: unknown): Goal | null {
	const g = (data as { goal?: any } | null)?.goal;
	if (!g || typeof g !== "object" || typeof g.text !== "string" || !STATUSES.has(g.status)) return null;
	return { text: g.text, status: g.status, waiting: !!g.waiting, updatedAt: typeof g.updatedAt === "number" ? g.updatedAt : null };
}

// Latest entry wins. Real pi writes `{goal:null}` straight after a `complete` entry, so a null
// that immediately follows a complete goal keeps it; any other null clears the goal.
export function goalFromEntries(entries: Array<{ type?: string; customType?: string; data?: unknown }>): Goal | null {
	let current: Goal | null = null;
	let prev: Goal | null = null; // the previous goal-state entry, parsed
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== "goal-state") continue;
		const g = parseGoal(e.data);
		const isNull = (e.data as { goal?: unknown } | null)?.goal === null;
		current = isNull && prev?.status === "complete" ? prev : g;
		prev = g;
	}
	return current;
}
