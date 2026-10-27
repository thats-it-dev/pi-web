// Clay settings page: the hub's address and the theme.
module.exports = [
	{ type: "heading", defaultValue: "pi-web" },
	{
		type: "section",
		items: [
			{ type: "input", messageKey: "HUB_URL", label: "Hub URL", attributes: { placeholder: "https://host:7878", type: "url" } },
			{ type: "toggle", messageKey: "DARK", label: "Dark theme", defaultValue: true },
		],
	},
	{ type: "submit", defaultValue: "Save" },
];
