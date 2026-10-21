import type { ClientRequest } from "node:http";
import { copyFileSync, cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { CSP } from "./src/lib/csp";

// In dev the app talks to the hub through Vite at the same origin. The proxy
// plays the part of `tailscale serve`: it adds the identity header the hub
// requires, an Origin header for same-origin GETs (browsers omit it), and
// X-Forwarded-Host with the dev hostname, so a client that reaches Vite by
// another name (the watch emulator uses 127.0.0.1:5173) still passes the
// hub's host check.
const HUB = process.env.PI_WEB_HUB ?? "http://127.0.0.1:7878";
const DEV_LOGIN = process.env.PI_WEB_DEV_LOGIN ?? "dev@local";
const DEV_ORIGIN = "http://localhost:5173";
const DEV_HOST = new URL(DEV_ORIGIN).host;

// Only built HTML gets the CSP, so Vite's dev client keeps working.
function csp(): Plugin {
	return {
		name: "pi-web-csp",
		apply: "build",
		transformIndexHtml: (html) => html.replace("<head>", `<head>\n\t\t<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
	};
}

// iOS 27's Add to Home Screen sheet fetches the apple-touch-icon with its own
// loader, which fails on a network URL and leaves a letter tile; an icon
// embedded as a data: URI works. The 180px PNG (2 KB) is inlined from the
// same file the icon script writes, so there is one source of truth.
function inlineTouchIcon(): Plugin {
	return {
		name: "pi-web-touch-icon",
		transformIndexHtml: (html) => {
			const png = readFileSync(new URL("./public/apple-touch-icon.png", import.meta.url));
			return html.replace("__APPLE_TOUCH_ICON__", `data:image/png;base64,${png.toString("base64")}`);
		},
	};
}

// The shared theme (../theme) is also published as-is at /theme/ so other
// thatsit.app apps can link https://pi.thatsit.app/theme/theme.css.
// pi-web itself imports it from global.css, where Vite hashes the fonts.
const THEME = dirname(fileURLToPath(import.meta.resolve("@thatsit/theme/theme.css")));
const THEME_TYPES: Record<string, string> = { ".css": "text/css", ".ttf": "font/ttf", ".md": "text/markdown; charset=utf-8" };
// theme-init.js must run as a classic script before first paint, so it is served as a file rather than bundled.
const THEME_INIT = fileURLToPath(import.meta.resolve("@thatsit/kit/theme-init.js"));

function publishTheme(): Plugin {
	let outDir = "dist";
	return {
		name: "pi-web-theme",
		configResolved(config) {
			outDir = config.build.outDir;
		},
		configureServer(server) {
			server.middlewares.use("/theme-init.js", (_req, res) => {
				res.setHeader("content-type", "text/javascript");
				res.end(readFileSync(THEME_INIT));
			});
			server.middlewares.use("/theme", (req, res, next) => {
				const file = join(THEME, normalize(decodeURIComponent((req.url ?? "/").split("?")[0])));
				const type = THEME_TYPES[extname(file)];
				if (!file.startsWith(THEME + "/") || !type || !existsSync(file)) return next();
				res.setHeader("content-type", type);
				res.setHeader("access-control-allow-origin", "*");
				res.end(readFileSync(file));
			});
		},
		writeBundle() {
			for (const f of ["theme.css", "README.md", "fonts"]) cpSync(join(THEME, f), join(outDir, "theme", f), { recursive: true });
			copyFileSync(THEME_INIT, join(outDir, "theme-init.js"));
		},
	};
}

export default defineConfig({
	plugins: [csp(), inlineTouchIcon(), publishTheme()],
	// One Lit, even if the app's and the kit's pins drift apart.
	resolve: { dedupe: ["lit"] },
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": {
				target: HUB,
				changeOrigin: false,
				ws: true,
				configure(proxy) {
					const stamp = (req: ClientRequest) => {
						req.setHeader("tailscale-user-login", DEV_LOGIN);
						req.setHeader("x-forwarded-host", DEV_HOST);
						if (!req.getHeader("origin")) req.setHeader("origin", DEV_ORIGIN);
					};
					proxy.on("proxyReq", stamp);
					proxy.on("proxyReqWs", stamp);
				},
			},
		},
	},
	test: { environment: "node", include: ["src/**/*.test.ts"] },
});
