// Runs before first paint (like thatsit.dev's inline script, but CSP-friendly).
(function () {
	var pref = "system";
	try {
		pref = localStorage.getItem("pi-web:theme") || "system";
	} catch (e) {}
	var media = window.matchMedia("(prefers-color-scheme: dark)");
	function apply() {
		var theme = pref === "light" || pref === "dark" ? pref : media.matches ? "dark" : "light";
		document.documentElement.setAttribute("data-theme", theme);
	}
	apply();
	media.addEventListener("change", function () {
		try {
			pref = localStorage.getItem("pi-web:theme") || "system";
		} catch (e) {}
		apply();
	});
})();
