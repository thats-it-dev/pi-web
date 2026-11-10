// Per-device settings in localStorage. Every access is guarded: private mode
// and blocked storage must not break the app.

const HUB_KEY = "pi-web:hub";
const THEME_KEY = "pi-web:theme";

export type ThemePref = "system" | "light" | "dark";

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {}
}

export function normalizeHubUrl(input: string): string {
	let s = input.trim();
	if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
	const url = new URL(s);
	if (!url.hostname.includes(".") && url.hostname !== "localhost") throw new Error(`"${input}" doesn't look like a hub address`);
	return url.origin;
}

// On the Vite dev server the hub is proxied at the same origin.
export function defaultHubUrl(loc: { hostname: string; origin: string } = location): string | null {
	return loc.hostname === "localhost" || loc.hostname === "127.0.0.1" ? loc.origin : null;
}

export function getHubUrl(): string | null {
	return read(HUB_KEY) ?? defaultHubUrl();
}

export function setHubUrl(url: string): void {
	write(HUB_KEY, normalizeHubUrl(url));
}

export function getTheme(): ThemePref {
	const t = read(THEME_KEY);
	return t === "light" || t === "dark" ? t : "system";
}

export function setTheme(pref: ThemePref): void {
	write(THEME_KEY, pref === "system" ? null : pref);
	const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
	for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute("content", dark ? "#171717" : "#f1f1f1"); // the status bar's color, as in theme-init.js
}
