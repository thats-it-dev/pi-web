import { defineConfig, devices } from "@playwright/test";

const HUB_PORT = 7898; // keep in sync with e2e/hub-for-e2e.ts

export default defineConfig({
	testDir: "e2e",
	timeout: 60_000,
	expect: { timeout: 15_000 },
	workers: 1,
	use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
	projects: [
		{ name: "desktop", use: { ...devices["Desktop Chrome"] } },
		{ name: "phone", use: { ...devices["Pixel 7"] } },
	],
	webServer: [
		{ command: "node e2e/hub-for-e2e.ts", port: HUB_PORT, reuseExistingServer: false, timeout: 30_000 },
		{ command: "npx vite --port 5173 --strictPort", port: 5173, reuseExistingServer: false, env: { PI_WEB_HUB: `http://127.0.0.1:${HUB_PORT}` } },
	],
});
