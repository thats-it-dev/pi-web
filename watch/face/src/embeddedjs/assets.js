// Type and colour (spec §6.1). The font strings live here only: system Leco for
// the time (digits and colon), Gothic for the rest until a LECO 1976 TTF lands.
// Dark is paper black, ink white; light inverts everything.
export function makeTheme(dark) {
	const paper = dark ? "#000000" : "#FFFFFF";
	const ink = dark ? "#FFFFFF" : "#000000";
	const style = (font, horizontal) => new Style({ font, color: ink, horizontal });
	return {
		skins: { paper: new Skin({ fill: paper }), ink: new Skin({ fill: ink }) },
		styles: {
			time: style("42px Leco", "center"),
			corner: style("bold 18px Gothic", "left"),
			cornerRight: style("bold 18px Gothic", "right"),
			small: style("14px Gothic", "left"),
			smallRight: style("14px Gothic", "right"),
			smallCenter: style("14px Gothic", "center"),
			body: style("18px Gothic", "left"),
			bodyCenter: style("18px Gothic", "center"),
		},
	};
}
