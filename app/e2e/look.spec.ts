import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const WORKDIR = join(tmpdir(), "pi-web-e2e-work"); // keep in sync with hub-for-e2e.ts

async function startSession(page: import("@playwright/test").Page) {
	await page.goto("/#/new");
	await page.getByLabel("Folder path").fill(WORKDIR);
	await page.getByRole("button", { name: "start session" }).click();
	await expect(page).toHaveURL(/#\/s\//);
}

const masks = (page: import("@playwright/test").Page) => [page.locator("pi-sidebar .ago"), page.locator("pi-header .l2")];

// The stats sheet shows the new session's file and id, which are random per run, and the sidebar lists whatever
// sessions earlier specs left on the hub.
const sessionSheetMasks = (page: import("@playwright/test").Page) => [
	...masks(page),
	page.locator("pi-sidebar .groups"),
	page.locator('dl.stats dt:has-text("session file") + dd, dl.stats dt:has-text("session id") + dd'),
];

// Pins the current look so the kit extraction can prove it changed nothing.
for (const scheme of ["light", "dark"] as const) {
	test.describe(scheme, () => {
		test.beforeEach(async ({ page }, info) => {
			await page.emulateMedia({ colorScheme: scheme });
			if (info.title === "session-sheet") return;
			// Other specs leave sessions behind on the shared hub; pin the sidebar to the empty state.
			await page.route(/\/api\/sessions$/, (route) =>
				route.request().method() === "GET" ? route.fulfill({ json: { sessions: [], home: "/home/e2e" } }) : route.fallback());
			// The new-session screen builds its recent-folder chips and default folder from this.
			await page.route(/\/api\/cwds$/, (route) => route.fulfill({ json: { cwds: [], home: "/home/e2e" } }));
		});

		const shot = async (page: import("@playwright/test").Page, name: string, mask = masks(page)) =>
			expect(page).toHaveScreenshot(`${name}-${scheme}.png`, { fullPage: false, maxDiffPixels: 50, mask });

		test("home", async ({ page }) => {
			await page.goto("/");
			await shot(page, "home");
		});

		test("settings", async ({ page }) => {
			// Store the choice explicitly so the theme control's state is the same one the forced-dark test reaches.
			await page.addInitScript((t) => localStorage.setItem("pi-web:theme", t), scheme);
			await page.goto("/#/settings");
			await shot(page, "settings");
		});

		test("settings-system", async ({ page }) => {
			await page.goto("/#/settings");
			await shot(page, "settings-system");
		});

		test("new", async ({ page }) => {
			await page.goto("/#/new");
			await shot(page, "new");
		});

		test("drawer", async ({ page, isMobile }) => {
			test.skip(!isMobile, "phone only");
			await page.goto("/");
			await page.getByRole("button", { name: "Open sessions" }).click();
			await shot(page, "drawer");
		});

		test("session-sheet", async ({ page }) => {
			await startSession(page);
			await page.getByLabel("Message").fill("hi");
			await page.getByRole("button", { name: "send" }).click(); // Enter doesn't send on the phone
			await expect(page.locator("pi-messages")).toContainText("Hello world");
			await page.getByRole("button", { name: "Session stats" }).click();
			await shot(page, "session-sheet", sessionSheetMasks(page));
		});

		test("toast", async ({ page }) => {
			await page.goto("/");
			await page.evaluate(() => window.dispatchEvent(new CustomEvent("pi-toast", { detail: { message: "Saved", level: "warning" } })));
			await shot(page, "toast");
		});
	});
}

test("forced dark theme looks like the dark scheme", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "light" });
	await page.addInitScript(() => localStorage.setItem("pi-web:theme", "dark"));
	await page.route(/\/api\/sessions$/, (route) =>
		route.request().method() === "GET" ? route.fulfill({ json: { sessions: [], home: "/home/e2e" } }) : route.fallback());
	await page.goto("/#/settings");
	await expect(page).toHaveScreenshot("settings-dark.png", { fullPage: false, maxDiffPixels: 50, mask: masks(page) });
});
