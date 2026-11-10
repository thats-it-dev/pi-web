export interface Linear {
	(v: number): number;
	readonly domain: [number, number];
	ticks(count?: number): number[];
}

/** d3-style step: 1/2/5 x 10^k closest to span / count. */
function tickStep(span: number, count: number): number {
	const raw = span / Math.max(1, count);
	const power = Math.floor(Math.log10(raw));
	const error = raw / 10 ** power;
	const mult = error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1;
	return mult * 10 ** power;
}

/** Ticks from the nice floor of lo to the nice ceil of hi. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
	if (lo > hi) [lo, hi] = [hi, lo];
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
	if (lo === hi) {
		const pad = Math.max(1, Math.abs(lo) * 0.05);
		lo -= pad;
		hi += pad;
	}
	const step = tickStep(hi - lo, count);
	const start = Math.floor(lo / step + 1e-9);
	const end = Math.ceil(hi / step - 1e-9);
	const out: number[] = [];
	for (let i = start; i <= end; i++) out.push(Math.round(i * step * 1e9) / 1e9);
	return out;
}

export function niceDomain(lo: number, hi: number, count = 4): [number, number] {
	const t = niceTicks(lo, hi, count);
	if (t.length === 0) return [lo, hi];
	return [t[0], t[t.length - 1]];
}

export function linearScale(domain: [number, number], range: [number, number]): Linear {
	const [d0, d1] = domain;
	const [r0, r1] = range;
	const span = d1 - d0;
	const fn = ((v: number) => (span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0))) as Linear & {
		domain: [number, number];
		ticks: (count?: number) => number[];
	};
	fn.domain = [d0, d1];
	fn.ticks = (count = 4) => niceTicks(d0, d1, count);
	return fn;
}

/** Nice domain covering values and goal; never zero-height. */
export function seriesDomain(values: readonly number[], goal?: number): [number, number] {
	const all = values.filter(Number.isFinite);
	if (goal !== undefined && Number.isFinite(goal)) all.push(goal);
	if (all.length === 0) return [0, 1];
	let lo = Math.min(...all);
	let hi = Math.max(...all);
	if (lo === hi) {
		const pad = Math.max(1, Math.abs(lo) * 0.05);
		lo -= pad;
		hi += pad;
	}
	return niceDomain(lo, hi);
}
