import "./styles/global.css";
import "./components/pi-app.ts";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js").catch(() => {});
}
