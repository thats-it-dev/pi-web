// Content-Security-Policy for the built app (see vite.config.ts). The hub URL
// is configured at runtime, so connect-src allows any tailnet host. A source
// without a port only matches 443, and `tailscale serve` uses others (:7878).
export const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self'",
	"img-src 'self' data: blob:",
	"connect-src 'self' https://*.ts.net:*",
	// Previews are tailnet dev servers, Pages previews and thatsit.app sites.
	"frame-src https://*.ts.net:* https://*.pages.dev https://*.thatsit.app",
	"manifest-src 'self'",
	"worker-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
].join("; ");
