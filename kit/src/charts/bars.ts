/** Goal tick position on the track, in both directions. */
export const GOAL_AT = 0.8;

function clamp01(n: number): number {
	return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function barFraction(value: number, o: { goal?: number; lower?: boolean; max?: number }): number {
	if (!Number.isFinite(value)) return 0;
	const { goal, lower, max } = o;
	const hasGoal = goal !== undefined && Number.isFinite(goal) && goal > 0;
	if (lower && hasGoal) return value <= 0 ? 1 : clamp01((GOAL_AT * goal) / value);
	if (hasGoal) return clamp01((GOAL_AT * value) / goal);
	if (max === undefined || !(max > 0)) return 0;
	return clamp01(value / max);
}

export function atGoal(value: number, goal: number, lower?: boolean): boolean {
	return lower ? value <= goal : value >= goal;
}
