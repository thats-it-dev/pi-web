// The two themes (spec §3): thatsit.app's colours snapped to the Time 2's 64.
// Status dots and the amber selection are the same in both; pi blue text is
// lighter on Dark, where #0055AA is too dim.
import { textLayerStyle } from "pebble-ui/sdk";

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

// textLayerStyle(font, color), one Style per font and colour for the app's
// life. Piu keeps a style link and a computed Style for every Style instance a
// content has used (application.styleList), freed only by application.purge(),
// which pebble-ui's WindowStack calls after each slide. So a new Style per
// rebuild stays in the chunk heap until the next window change.
const styles = {};
export function style(font, color) {
	return styles[font + color] ??= textLayerStyle(font, color);
}
