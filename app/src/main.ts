import "./styles/global.css";
import "./components/pi-app.ts";
import { openHashFromMessage } from "./lib/push.ts";
import { toast, trackViewport } from "@thatsit/kit";
import { startVpDebug } from "./lib/vp-debug.ts";

trackViewport();
startVpDebug();
warnStaleInstall();

// iOS keeps the status-bar style it saw when the app was added to the Home
// Screen. index.html asks for the default bar (the translucent one is broken
// on iOS 26: an unpaintable strip at the bottom and a blur over the header),
// so an install that still draws under the status bar is from before that.
function warnStaleInstall(): void {
	if (!matchMedia("(display-mode: standalone)").matches) return;
	const probe = document.createElement("div");
	probe.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:env(safe-area-inset-top);visibility:hidden;pointer-events:none";
	document.body.append(probe);
	const underStatusBar = probe.getBoundingClientRect().height > 0;
	probe.remove();
	if (underStatusBar) setTimeout(() => toast("iOS kept this app's old status-bar setting. Remove pi from the Home Screen and add it again.", "warning"), 1000);
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js").catch(() => {});
	navigator.serviceWorker.addEventListener("message", (e) => {
		const hash = openHashFromMessage(e.data);
		if (hash) location.hash = hash;
	});
}
