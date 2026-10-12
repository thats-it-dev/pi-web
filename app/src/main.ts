import "./styles/global.css";
import "./components/pi-app.ts";
import { openHashFromMessage } from "./lib/push.ts";
import { trackViewport } from "./lib/viewport.ts";

trackViewport();

if (import.meta.env.PROD && "serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js").catch(() => {});
	navigator.serviceWorker.addEventListener("message", (e) => {
		const hash = openHashFromMessage(e.data);
		if (hash) location.hash = hash;
	});
}
