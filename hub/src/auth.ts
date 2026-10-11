// Every request must come from an allowed page (Origin), to the tailnet host
// (Host), as the allowed Tailscale user. The identity header is ambient: tailscale
// serve adds it to any request this device makes, including ones another
// website triggers, so the Origin check is what makes it safe (spec §6).

import type { IncomingHttpHeaders } from "node:http";
import type { HubConfig } from "./config.ts";

type AuthConfig = Pick<HubConfig, "hostname" | "allowedLogin" | "allowedOrigins">;
export type AuthResult = { ok: true } | { ok: false; reason: string };

export function checkRequest(cfg: AuthConfig, h: IncomingHttpHeaders): AuthResult {
	const origin = h.origin;
	if (!origin || !cfg.allowedOrigins.includes(origin)) return { ok: false, reason: `origin ${origin ?? "(none)"}` };
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
