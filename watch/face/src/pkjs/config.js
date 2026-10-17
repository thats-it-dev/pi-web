// Clay settings page: the four corners, the theme, the hub's address and the unit.
function corner(key, label, value) {
	return {
		type: "select",
		messageKey: key,
		label: label,
		defaultValue: value,
		options: ["date", "pi", "hr", "steps", "battery", "weather", "none"].map(function (id) {
			return { label: id, value: id };
		}),
	};
}

module.exports = [
	{ type: "heading", defaultValue: "pi-web face" },
	{
		type: "section",
		items: [
			{ type: "heading", defaultValue: "Corners" },
			corner("CORNER_TL", "Top left", "date"),
			corner("CORNER_TR", "Top right", "pi"),
			corner("CORNER_BL", "Bottom left", "hr"),
			corner("CORNER_BR", "Bottom right", "steps"),
		],
	},
	{
		type: "section",
		items: [
			{ type: "toggle", messageKey: "DARK", label: "Dark", defaultValue: true },
			{ type: "input", messageKey: "HUB_URL", label: "Hub URL", attributes: { placeholder: "https://host:7878", type: "url" } },
			{
				type: "radiogroup",
				messageKey: "UNIT",
				label: "Temperature",
				defaultValue: "C",
				options: [
					{ label: "Celsius", value: "C" },
					{ label: "Fahrenheit", value: "F" },
				],
			},
		],
	},
	{ type: "submit", defaultValue: "Save" },
];
