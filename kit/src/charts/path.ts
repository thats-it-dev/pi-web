export type Pt = { x: number; y: number } | null;

function r(v: number): number {
	const n = Math.round(v * 10) / 10;
	return n === 0 ? 0 : n;
}

function runs(...lines: readonly (readonly Pt[])[]): number[][] {
	const len = Math.min(...lines.map((l) => l.length));
	const out: number[][] = [];
	let cur: number[] = [];
	for (let i = 0; i < len; i++) {
		if (lines.every((l) => l[i] !== null)) cur.push(i);
		else if (cur.length) {
			out.push(cur);
			cur = [];
		}
	}
	if (cur.length) out.push(cur);
	return out;
}

export function linePath(points: readonly Pt[]): string {
	return runs(points)
		.map((run) => {
			if (run.length === 1) {
				const p = points[run[0]]!;
				return `M${r(p.x)},${r(p.y)}h0`;
			}
			return run.map((i, j) => `${j ? "L" : "M"}${r(points[i]!.x)},${r(points[i]!.y)}`).join("");
		})
		.join("");
}

/** The points that are a run of one (a day with a value on both sides missing); a path draws those as nothing visible. */
export function isolated(points: readonly Pt[]): { x: number; y: number }[] {
	return runs(points).filter((run) => run.length === 1).map((run) => points[run[0]]!);
}

export function areaPath(top: readonly Pt[], bottom: readonly Pt[]): string {
	return runs(top, bottom)
		.filter((run) => run.length >= 2)
		.map((run) => {
			const t = run.map((i, j) => `${j ? "L" : "M"}${r(top[i]!.x)},${r(top[i]!.y)}`).join("");
			const b = [...run].reverse().map((i) => `L${r(bottom[i]!.x)},${r(bottom[i]!.y)}`).join("");
			return `${t}${b}Z`;
		})
		.join("");
}
