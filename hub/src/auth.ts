// Every app request must come from an allowed page (Origin), to the tailnet host
// (Host), as the allowed Tailscale user. The identity header is ambient: tailscale
// serve adds it to any request this device makes, including ones another
// website triggers, so the Origin check is what makes it safe (spec §6). The
// Origin check applies to app routes; /api/watch/* (bearer token) and
// /api/index/webhook (HMAC signature) are exempt from Origin but still require
// Host and the Tailscale identity.

import type { IncomingHttpHeaders } from "node:http";
import type { HubConfig } from "./config.ts";
import { bearerMatches } from "./watch-secrets.ts";

type AuthConfig = Pick<HubConfig, "hostname" | "allowedLogin" | "allowedOrigins">;
export type AuthResult = { ok: true } | { ok: false; reason: string };

export function checkRequest(cfg: AuthConfig, h: IncomingHttpHeaders): AuthResult {
	const origin = h.origin;
	if (!origin || !cfg.allowedOrigins.includes(origin)) return { ok: false, reason: `origin ${origin ?? "(none)"}` };
	return checkHostAndLogin(cfg, h);
}

// Watch routes are called by the phone app, not a page, so there is no Origin;
// the bearer token stands in for it.
export function checkWatchRequest(cfg: AuthConfig, h: IncomingHttpHeaders, token: string): AuthResult {
	const base = checkHostAndLogin(cfg, h);
	if (!base.ok) return base;
	return bearerMatches(h.authorization, token) ? { ok: true } : { ok: false, reason: "watch token" };
}

export function checkHostAndLogin(cfg: AuthConfig, h: IncomingHttpHeaders): AuthResult {
	// tailscale serve may forward the original host as X-Forwarded-Host. A client
	// that could forge that header is not a browser, and cannot get the identity
	// header either unless it runs on this machine as this user.
	if (h.host !== cfg.hostname && h["x-forwarded-host"] !== cfg.hostname) return { ok: false, reason: `host ${h.host}` };
	const login = h["tailscale-user-login"];
	if (login !== cfg.allowedLogin) return { ok: false, reason: `login ${login ?? "(none)"}` };
	return { ok: true };
}

export function corsHeaders(cfg: Pick<HubConfig, "allowedOrigins">, origin: string | undefined): Record<string, string> {
	if (!origin || !cfg.allowedOrigins.includes(origin)) return {};
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "content-type",
		"access-control-max-age": "600",
		vary: "Origin",
	};
}
