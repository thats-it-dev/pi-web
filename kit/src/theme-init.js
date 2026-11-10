// Runs before first paint (like thatsit.dev's inline script, but CSP-friendly).
(function () {
	var key = (document.currentScript && document.currentScript.dataset.key) || "thatsit:theme";
	var pref = "system";
	try {
		pref = localStorage.getItem(key) || "system";
	} catch (e) {}
	var media = window.matchMedia("(prefers-color-scheme: dark)");
	function apply() {
		var theme = pref === "light" || pref === "dark" ? pref : media.matches ? "dark" : "light";
		document.documentElement.setAttribute("data-theme", theme);
		// iOS colors the status bar from theme-color; follow the app's theme, not just the system's.
		// The media queries come off once the color is resolved: iPadOS re-reads the tag on in-app
		// navigation and turned the bar black, so there is exactly one color for it to find.
		var metas = document.querySelectorAll('meta[name="theme-color"]');
		for (var i = 0; i < metas.length; i++) {
			metas[i].removeAttribute("media");
			metas[i].setAttribute("content", theme === "dark" ? "#171717" : "#f1f1f1");
		}
	}
	// A fresh copy of the tag makes WebKit apply the color again after a hash or history navigation.
	function reapply() {
		var metas = document.querySelectorAll('meta[name="theme-color"]');
		for (var i = 0; i < metas.length; i++) metas[i].replaceWith(metas[i].cloneNode());
	}
	apply();
	window.addEventListener("hashchange", reapply);
	window.addEventListener("popstate", reapply);
	media.addEventListener("change", function () {
		try {
			pref = localStorage.getItem(key) || "system";
		} catch (e) {}
		apply();
	});
})();
