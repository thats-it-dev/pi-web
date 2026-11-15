import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_HEIGHT, routeOf, SCALE, screenFile, screenshotApp, VIEWPORT } from "../scripts/lib/screenshot.ts";

test("screenFile names the picture by scheme and route, under the ignored test-results", () => {
	assert.equal(screenFile("/a/keeb", "dark"), "/a/keeb/test-results/screens/phone-dark.png");
	assert.equal(screenFile("/a/keeb", "light", "/"), "/a/keeb/test-results/screens/phone-light.png");
	assert.equal(screenFile("/a/keeb", "dark", "/settings/sync"), "/a/keeb/test-results/screens/phone-dark-settings-sync.png");
	assert.equal(screenFile("/a/keeb", "dark", "/", 'button[aria-label="Settings"]'), "/a/keeb/test-results/screens/phone-dark-click-button-aria-label-Settings.png");
});

test("routeOf accepts a route with or without the slash", () => {
	assert.equal(routeOf(undefined), "/");
	assert.equal(routeOf("/"), "/");
	assert.equal(routeOf("stats"), "/stats");
	assert.equal(routeOf("/stats?x=1"), "/stats?x=1");
});

// A fake vite and playwright: checks the flow (serve, render wait, clip, close) without a browser.
function fakes(pageHeight: number, rendered = true) {
	const calls: string[] = [];
	const page = {
		on: () => undefined,
		goto: async (url: string) => void calls.push(`goto ${url}`),
		click: async (selector: string) => {
			if (selector === "#missing") throw new Error("Timeout 10000ms exceeded.\nwaiting for locator('#missing')");
			calls.push(`click ${selector}`);
		},
		waitForTimeout: async () => undefined,
		waitForFunction: async () => {
			if (!rendered) throw new Error("timeout");
		},
		waitForLoadState: async () => undefined,
		evaluate: async <T>(expr: string): Promise<T> => (expr.includes("scrollHeight") ? pageHeight : undefined) as T,
		screenshot: async (o: { path: string; clip: { height: number } }) => {
			calls.push(`shot ${o.clip.height}`);
			const { writeFileSync } = await import("node:fs");
			writeFileSync(o.path, "png");
			return Buffer.from("png");
		},
	};
	const deps = {
		createServer: async () => ({ listen: async () => void calls.push("listen"), close: async () => void calls.push("close server"), resolvedUrls: { local: ["http://127.0.0.1:5173/"] } }),
		chromium: { launch: async () => ({ newContext: async () => ({ newPage: async () => page, close: async () => undefined }), close: async () => void calls.push("close browser") }) },
	};
	return { deps, calls };
}

test("screenshotApp serves the app, waits for app-main, writes the clipped picture and closes everything", async () => {
	const dir = mkdtempSync(join(tmpdir(), "shot-"));
	const { deps, calls } = fakes(1200);
	const r = await screenshotApp(dir, { path: "stats" }, deps);
	assert.equal(r.file, join(dir, "test-results", "screens", "phone-dark-stats.png"));
	assert.ok(existsSync(r.file));
	assert.equal(readFileSync(r.file, "utf8"), "png");
	assert.deepEqual([r.width, r.height], [VIEWPORT.width * SCALE, 1200 * SCALE]);
	assert.deepEqual(r.issues, []);
	assert.deepEqual(calls, ["listen", "goto http://127.0.0.1:5173/stats", "shot 1200", "close browser", "close server"]);
});

test("screenshotApp cuts a very long page and reports a screen that never rendered", async () => {
	const dir = mkdtempSync(join(tmpdir(), "shot-"));
	const long = await screenshotApp(dir, {}, fakes(9000).deps);
	assert.equal(long.height, MAX_HEIGHT * SCALE);
	assert.match(long.issues[0], /9000 px tall/);
	const blank = await screenshotApp(dir, {}, fakes(300, false).deps);
	assert.equal(blank.height, VIEWPORT.height * SCALE, "never shorter than the viewport");
	assert.match(blank.issues[0], /app-main rendered nothing/);
});

test("screenshotApp clicks the selector once the app rendered, and reports a click that found nothing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "shot-"));
	const { deps, calls } = fakes(900);
	const r = await screenshotApp(dir, { click: 'button[aria-label="Settings"]' }, deps);
	assert.equal(r.file, join(dir, "test-results", "screens", "phone-dark-click-button-aria-label-Settings.png"));
	assert.deepEqual(r.issues, []);
	assert.deepEqual(calls, ["listen", "goto http://127.0.0.1:5173/", 'click button[aria-label="Settings"]', "shot 900", "close browser", "close server"]);
	const miss = await screenshotApp(dir, { click: "#missing" }, fakes(900).deps);
	assert.match(miss.issues[0], /^--click #missing: Timeout 10000ms exceeded\.; the picture shows the screen without the click$/);
});
