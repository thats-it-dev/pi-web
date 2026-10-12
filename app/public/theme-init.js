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
		// iOS colors the status bar from theme-color; follow the app's theme, not just the system's.
		var metas = document.querySelectorAll('meta[name="theme-color"]');
		for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", theme === "dark" ? "#171717" : "#f1f1f1");
	}
	apply();
	media.addEventListener("change", function () {
		try {
			pref = localStorage.getItem("pi-web:theme") || "system";
		} catch (e) {}
		apply();
	});
})();
