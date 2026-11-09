// Whether a subagent's thread keeps re-reading its transcript: only while the parent is live, and
// then while nothing has loaded yet (the child may not have written its file; a 404 is retried) or
// the child is running or unknown. A finished child, or a parent that isn't live, stops it.
import type { SubagentChild } from "../../../shared/src/progress.ts";

export function childThreadPolls(live: boolean, child: Pick<SubagentChild, "state"> | null): boolean {
	if (!live) return false;
	return !child || child.state === "running" || child.state === "unknown";
}
