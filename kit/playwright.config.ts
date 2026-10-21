import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	timeout: 30_000,
	expect: { timeout: 10_000 },
	workers: 1,
	use: { baseURL: "http://localhost:5180", trace: "retain-on-failure" },
	projects: [
		{ name: "desktop", use: { ...devices["Desktop Chrome"] } },
		{ name: "phone", use: { ...devices["Pixel 7"] } },
	],
	// Serves the built dist, so the test exercises exactly what gets published.
	webServer: { command: "npx vite preview --outDir dist --port 5180 --strictPort", port: 5180, reuseExistingServer: false, timeout: 30_000 },
});
