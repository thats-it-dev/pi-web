import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// In dev the app talks to the hub through Vite at the same origin. The proxy
// plays the part of `tailscale serve`: it adds the identity header the hub
// requires, and an Origin header for same-origin GETs (browsers omit it).
const HUB = process.env.PI_WEB_HUB ?? "http://127.0.0.1:7878";
const DEV_LOGIN = process.env.PI_WEB_DEV_LOGIN ?? "dev@local";
const DEV_ORIGIN = "http://localhost:5173";

const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self'",
	"img-src 'self' data: blob:",
	"connect-src 'self' https://*.ts.net",
	"manifest-src 'self'",
	"worker-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
].join("; ");

// Only built HTML gets the CSP, so Vite's dev client keeps working.
function csp(): Plugin {
	return {
		name: "pi-web-csp",
		apply: "build",
		transformIndexHtml: (html) => html.replace("<head>", `<head>\n\t\t<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
	};
}

export default defineConfig({
	plugins: [csp()],
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": {
				target: HUB,
				changeOrigin: false,
				configure(proxy) {
					proxy.on("proxyReq", (req) => {
						req.setHeader("tailscale-user-login", DEV_LOGIN);
						if (!req.getHeader("origin")) req.setHeader("origin", DEV_ORIGIN);
					});
				},
			},
		},
	},
	test: { environment: "node", include: ["src/**/*.test.ts"] },
});
