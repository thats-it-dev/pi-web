// Reads progress out of a superpowers plan: `### Task N: ...` sections with `- [ ]` step boxes.

export interface PlanTask { title: string; done: number; total: number }
export interface PlanDoc { title: string | null; tasks: PlanTask[]; current: number | null }

export function parsePlan(markdown: string): PlanDoc {
	let title: string | null = null;
	const tasks: PlanTask[] = [];
	let fence: string | null = null;
	let cur: PlanTask | null = null; // the task boxes count toward; any other heading ends it
	for (const line of markdown.split("\n")) {
		const f = /^\s*(`{3,}|~{3,})/.exec(line);
		if (f) {
			if (!fence) fence = f[1][0];
			else if (f[1][0] === fence) fence = null;
			continue;
		}
		if (fence) continue;
		const h = /^(#{1,3})\s+(.*?)\s*#*\s*$/.exec(line);
		if (h) {
			if (h[1] === "#" && title === null) title = h[2];
			cur = null;
			if (h[1] === "###" && /^Task\b/i.test(h[2])) tasks.push((cur = { title: h[2], done: 0, total: 0 }));
			continue;
		}
		const box = /^\s*[-*+]\s+\[([ xX])\]/.exec(line);
		if (box && cur) {
			cur.total++;
			if (box[1] !== " ") cur.done++;
		}
	}
	const i = tasks.findIndex((t) => t.done < t.total);
	return { title, tasks, current: i < 0 ? null : i };
}
