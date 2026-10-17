export const FONT_FAMILY = "Gothic";
export const FONT = FONT_FAMILY;
export const SIZES = { small: 14, body: 18 };
export const METRICS = { status: 18, toolbar: 16, rule: 2, row: 32, row2: 44, bar: 60 };

export function theme(dark) {
	const paper = dark ? "#000000" : "#FFFFFF";
	const ink = dark ? "#FFFFFF" : "#000000";
	const dim = "#AAAAAA";
	const small = SIZES.small + "px " + FONT;
	const body = SIZES.body + "px " + FONT;
	return {
		paper,
		ink,
		dim,
		skins: {
			paper: { fill: paper },
			ink: { fill: ink },
			dim: { fill: dim },
			rule: { fill: ink },
		},
		styles: {
			small: { font: small, color: ink, horizontal: "left" },
			smallRight: { font: small, color: ink, horizontal: "right" },
			body: { font: body, color: ink, horizontal: "left", leading: Math.round(SIZES.body * 1.2) },
			bodyRight: { font: body, color: ink, horizontal: "right" },
			meta: { font: small, color: dim, horizontal: "left" },
		},
	};
}
