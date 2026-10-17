// Type and colour (spec §7.1). The UI uses the system Gothic font (LECO 1976
// could not be fetched; see watch/README.md, Known issues). Round 2 (§7.10):
// the status line takes two centred lines, text is centred and inset from the rim.
export const ROUND = screen.round;
export const METRICS = {
	status: ROUND ? 38 : 18, toolbar: 16, rule: 2, row: 32, row2: 44,
	bar: ROUND ? 32 : 60, // the context bar; short on Round 2 so the toolbar clears the rim
	pad: ROUND ? 18 : 4, // the inset of text from the screen's edge
	bottom: ROUND ? 18 : 0, // paper under the rows, where the rim cuts them
};

// Dark is paper black, ink white. Dim on light paper is darker than on black to
// keep contrast; the context-bar track sits under an ink fill, so it contrasts with ink.
export function makeTheme(dark) {
	const paper = dark ? "#000000" : "#FFFFFF";
	const ink = dark ? "#FFFFFF" : "#000000";
	const dim = dark ? "#AAAAAA" : "#555555";
	const align = ROUND ? "center" : "left";
	const style = (size, color, horizontal = "left") => new Style({ font: size + "px Gothic", color, horizontal });
	return {
		skins: { paper: new Skin({ fill: paper }), ink: new Skin({ fill: ink }), track: new Skin({ fill: dark ? "#555555" : "#AAAAAA" }) },
		styles: {
			small: style(14, ink),
			smallRight: style(14, ink, "right"),
			status: style(14, ink, align),
			body: style(18, ink),
			bodyRight: style(18, ink, "right"),
			query: style(18, ink, align),
			meta: style(14, dim),
			hint: style(14, dim, align),
			// Menu rows: [normal, selected] colours; the selected row sits on an ink bar (Menu.js).
			row: style(18, [ink, paper], align),
			rowMeta: style(14, [dim, paper], align),
			rowDim: style(18, [dim, paper], align),
			rowValue: style(14, [dim, paper], "right"),
		},
	};
}
