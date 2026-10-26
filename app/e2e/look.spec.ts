import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";

const WORKDIR = join(tmpdir(), "pi-web-e2e-work"); // keep in sync with hub-for-e2e.ts

// A new chat in the work folder on Fake A (whatever earlier specs picked last), sent: the session starts with its
// first message.
async function startChat(page: Page, text: string) {
	await page.goto("/#/new");
	await expect(page.getByRole("button", { name: /^Model Fake/ })).toBeVisible(); // the menu's rows move when the models arrive
	await page.getByRole("button", { name: "Chat options" }).click();
	await page.getByRole("button", { name: /^folder/ }).click();
	await page.getByLabel("Folder path").fill(WORKDIR);
	await page.getByLabel("Folder path").press("Enter");
	await page.getByRole("button", { name: /^model/ }).click();
	await page.getByRole("option", { name: /Fake A/ }).click();
	await page.keyboard.press("Escape");
	await page.getByLabel("Message").fill(text);
	await page.getByRole("button", { name: "send" }).click(); // Enter doesn't send on the phone
	await expect(page).toHaveURL(/#\/s\//);
}

const FAKE_A = { id: "fake-a", name: "Fake A", provider: "fake", reasoning: true, input: ["text", "image"], contextWindow: 1000, maxTokens: 100 };
const FAKE_B = { id: "fake-b", name: "Fake B", provider: "fake", reasoning: false, input: ["text"], contextWindow: 2000, maxTokens: 100 };
const LEVELS = ["off", "minimal", "low", "medium", "high"];
// What a new chat starts from, pinned: the hub's own answer follows whichever model earlier specs picked last.
const DEFAULTS = { models: [FAKE_A, FAKE_B], model: { provider: "fake", modelId: "fake-a", thinking: "medium" }, thinkingLevels: LEVELS, levels: { "fake/fake-a": LEVELS }, approvalMode: "semi", home: "/home/e2e" };

const masks = (page: Page) => [page.locator("pi-sidebar .ago"), page.locator("pi-header .l2")];

// The stats sheet shows the new session's file and id, which are random per run, and the sidebar lists whatever
// sessions earlier specs left on the hub.
const sessionSheetMasks = (page: Page) => [
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
			// A new chat's folder view lists recent folders from this.
			await page.route(/\/api\/cwds$/, (route) => route.fulfill({ json: { cwds: [], home: "/home/e2e" } }));
			await page.route(/\/api\/defaults$/, (route) => route.fulfill({ json: DEFAULTS }));
		});

		const shot = async (page: Page, name: string, mask = masks(page)) =>
			expect(page).toHaveScreenshot(`${name}-${scheme}.png`, { fullPage: false, maxDiffPixels: 50, mask });

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

		test("new-chat", async ({ page }) => {
			await page.goto("/#/new");
			await expect(page.getByRole("button", { name: /^Model Fake A/ })).toBeVisible();
			await shot(page, "new-chat");
		});

		test("chat-menu", async ({ page }) => {
			await page.goto("/#/new");
			await expect(page.getByRole("button", { name: /^Model Fake A/ })).toBeVisible();
			await page.getByRole("button", { name: "Chat options" }).click();
			await expect(page.getByRole("button", { name: /^approvals/ })).toContainText("semi");
			await page.mouse.move(0, 0); // no row hover in the shot
			await shot(page, "chat-menu");
		});

		test("drawer", async ({ page, isMobile }) => {
			test.skip(!isMobile, "phone only");
			await page.goto("/");
			await expect(page.getByRole("button", { name: /^Model Fake A/ })).toBeVisible();
			await page.getByRole("button", { name: "Open sessions" }).click();
			await shot(page, "drawer");
		});

		test("session-sheet", async ({ page }) => {
			await startChat(page, "hi");
			await expect(page.locator("pi-messages")).toContainText("Hello world");
			await page.getByRole("button", { name: "Session stats" }).click();
			await shot(page, "session-sheet", sessionSheetMasks(page));
		});

		test("toast", async ({ page }) => {
			await page.goto("/");
			await expect(page.getByRole("button", { name: /^Model Fake A/ })).toBeVisible();
			await page.evaluate(() => window.dispatchEvent(new CustomEvent("tk-toast", { detail: { message: "Saved", level: "warning" } })));
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

// The header is sticky inside the session's scroll pane; a 1px scroll must not move it (or tuck it).
test("header stays pinned", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone only");
	await startChat(page, "hi");
	await expect(page.locator("pi-messages").getByText("Hello world")).toHaveCount(1);
	for (let i = 1; i < 3; i++) {
		await page.getByLabel("Message").fill("hi");
		await page.getByRole("button", { name: "send" }).click();
		await expect(page.locator("pi-messages").getByText("Hello world")).toHaveCount(i + 1);
	}
	const header = page.locator("pi-header >> tk-header");
	expect(await header.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
	await page.locator("pi-session .scroll").evaluate((el) => el.scrollBy(0, -1));
	await expect.poll(async () => (await header.boundingBox())?.y).toBe(0);
});
