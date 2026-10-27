// The two themes (spec §3): thatsit.app's colours snapped to the Time 2's 64.
// Status dots and the amber selection are the same in both; pi blue text is
// lighter on Dark, where #0055AA is too dim.
export const AMBER = "#FFAA00";
export const BLACK = "#000000";

export function palette(dark) {
	const fg = dark ? "#FFFFFF" : BLACK;
	return {
		bg: dark ? BLACK : "#FFFFFF",
		fg,
		sub: dark ? "#AAAAAA" : "#555555",
		done: dark ? "#555555" : "#AAAAAA",
		pi: dark ? "#55AAFF" : "#0055AA",
		ring: "#00AA55",
		err: "#FF0055",
		wait: AMBER,
		line: fg,
	};
}
