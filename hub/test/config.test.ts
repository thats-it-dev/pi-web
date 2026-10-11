import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, DEFAULTS, loadConfig } from "../src/config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-web-config-"));

test("first run writes defaults (0600) and explains what to set", () => {
	const dir = tmp();
	assert.throws(() => loadConfig(dir), (e: unknown) => e instanceof ConfigError && /hostname and allowedLogin/.test(e.message));
	const file = join(dir, "config.json");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), DEFAULTS);
	assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a filled-in config loads with defaults merged and dataDir set", () => {
	const dir = tmp();
	writeFileSync(join(dir, "config.json"), JSON.stringify({ hostname: "spark-713a.tail9274fa.ts.net:7878", allowedLogin: "michaelthatsit@github" }));
	const cfg = loadConfig(dir);
	assert.equal(cfg.port, 7878);
	assert.equal(cfg.maxHeadless, 6);
	assert.deepEqual(cfg.allowedOrigins, ["https://pi.thatsit.app"]);
	assert.equal(cfg.dataDir, dir);
});

test("dev mode adds the Vite dev origin", () => {
	const dir = tmp();
	writeFileSync(join(dir, "config.json"), JSON.stringify({ hostname: "localhost:5173", allowedLogin: "dev@local", dev: true }));
	assert.ok(loadConfig(dir).allowedOrigins.includes("http://localhost:5173"));
});
