import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRequest, corsHeaders } from "../src/auth.ts";

const cfg = { hostname: "spark-713a.tail9274fa.ts.net:7878", allowedLogin: "michaelthatsit@github", allowedOrigins: ["https://pi.thatsit.app"] };
const good = { origin: "https://pi.thatsit.app", host: "spark-713a.tail9274fa.ts.net:7878", "tailscale-user-login": "michaelthatsit@github" };

test("accepts the allowed origin, host and login", () => {
	assert.deepEqual(checkRequest(cfg, good), { ok: true });
});

test("accepts the tailnet host via X-Forwarded-Host when tailscale rewrote Host", () => {
	assert.deepEqual(checkRequest(cfg, { ...good, host: "127.0.0.1:7878", "x-forwarded-host": cfg.hostname }), { ok: true });
});

const rejects: Array<[string, Record<string, string | undefined>]> = [
	["missing origin", { ...good, origin: undefined }],
	["other website", { ...good, origin: "https://evil.example" }],
	["origin with path tricks", { ...good, origin: "https://pi.thatsit.app.evil.example" }],
	["wrong host (DNS rebinding)", { ...good, host: "evil.example:7878" }],
	["no tailscale identity", { ...good, "tailscale-user-login": undefined }],
	["someone else on the tailnet", { ...good, "tailscale-user-login": "guest@github" }],
];
for (const [name, headers] of rejects) {
	test(`rejects: ${name}`, () => {
		assert.equal(checkRequest(cfg, headers).ok, false);
	});
}

test("CORS headers only echo an allowed origin", () => {
	assert.equal(corsHeaders(cfg, "https://pi.thatsit.app")["access-control-allow-origin"], "https://pi.thatsit.app");
	assert.deepEqual(corsHeaders(cfg, "https://evil.example"), {});
	assert.deepEqual(corsHeaders(cfg, undefined), {});
});

