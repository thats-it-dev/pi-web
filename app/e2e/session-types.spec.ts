import { type Page, expect, test } from "@playwright/test";

const codeTitle = (page: Page) => page.locator("pi-sidebar .row .t");
const toggle = (page: Page, name: "Code sessions" | "Chat sessions") => page.locator("pi-sidebar").getByRole("button", { name });
const newButton = (page: Page) => page.locator("pi-sidebar .new-session");

// A phone keeps the session list in a drawer.
async function openPanel(page: Page, isMobile: boolean) {
	if (isMobile) await page.getByRole("button", { name: "Open sessions" }).click();
	await expect(page.locator("pi-sidebar")).toBeVisible();
}

async function menuRow(page: Page, name: RegExp) {
	await expect(page.getByRole("button", { name: /^Model Fake/ })).toBeVisible(); // the menu's rows move when the models arrive
	await page.getByRole("button", { name: "Chat options" }).click();
	return page.getByRole(/superpowers/.test(String(name)) ? "switch" : "button", { name });
}

const apiSessions = async (page: Page) => ((await (await page.request.get("/api/sessions")).json()) as { sessions: { id: string; type: string; cwd?: string }[] }).sessions;

test("the toggle filters the list and the button label follows", async ({ page, isMobile }) => {
	await page.goto("/#/new");
	await openPanel(page, isMobile);
	await expect(toggle(page, "Code sessions")).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator("pi-sidebar").getByRole("radiogroup")).toBeVisible();
	await expect(codeTitle(page).filter({ hasText: "show me the app" }).first()).toBeVisible();
	await expect(codeTitle(page).filter({ hasText: "chatty hello" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^new (code session|chat)$/ })).toHaveText(/new code session/);

	await toggle(page, "Chat sessions").click();
	await expect(toggle(page, "Chat sessions")).toHaveAttribute("aria-pressed", "true");
	await expect(codeTitle(page).filter({ hasText: "chatty hello" })).toBeVisible();
	await expect(codeTitle(page).filter({ hasText: "show me the app" })).toHaveCount(0);
	await expect(newButton(page)).toHaveText(/new chat/);
	await expect(page.getByRole("button", { name: /^new (code session|chat)$/ })).toBeVisible();
});

test("the open session stays when the toggle flips", async ({ page, isMobile }) => {
	await page.goto("/#/s/e2e-chat");
	await openPanel(page, isMobile);
	const url = page.url();
	await toggle(page, "Chat sessions").click();
	await toggle(page, "Code sessions").click();
	await expect(page).toHaveURL(url);
});

// These start from settings: tapping "new" while already on /#/new changes no hash, so a phone's drawer would stay open.
test("a new chat lands in home with no folder row", async ({ page, isMobile }) => {
	await page.goto("/#/settings");
	await openPanel(page, isMobile);
	await toggle(page, "Chat sessions").click();
	await newButton(page).click();
	await expect(page.getByRole("heading", { name: "new chat" })).toBeVisible();
	await expect(await menuRow(page, /^folder/)).toHaveCount(0);
	await expect(page.getByRole("switch", { name: /^superpowers/ })).toHaveAttribute("aria-checked", "false");
	await page.keyboard.press("Escape");
	await page.getByLabel("Message").fill("hi");
	await page.getByRole("button", { name: "send" }).click();
	await expect(page).toHaveURL(/#\/s\//);
	const id = page.url().split("/s/")[1];
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await expect(await menuRow(page, /^folder/)).toHaveCount(0);
	await expect.poll(async () => (await apiSessions(page)).find((s) => s.id === id)?.type).toBe("chat");
});

test("a new code session starts with superpowers on", async ({ page, isMobile }) => {
	await page.goto("/#/settings");
	await openPanel(page, isMobile);
	await toggle(page, "Code sessions").click();
	await newButton(page).click();
	await expect(page.getByRole("heading", { name: "new code session" })).toBeVisible();
	await expect(await menuRow(page, /^superpowers/)).toHaveAttribute("aria-checked", "true");
	await expect(page.getByRole("button", { name: /^folder/ })).toBeVisible();
});

test("the setting survives a reload", async ({ page, isMobile }) => {
	await page.goto("/#/new");
	await openPanel(page, isMobile);
	await toggle(page, "Chat sessions").click();
	await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-web:session-type"))).toBe("chat");
	await page.reload();
	await openPanel(page, isMobile);
	await expect(toggle(page, "Chat sessions")).toHaveAttribute("aria-pressed", "true");
	await expect(newButton(page)).toHaveText(/new chat/);
});

test("flipping the toggle keeps the typed draft", async ({ page, isMobile }) => {
	await page.goto("/#/new");
	await expect(page.getByRole("button", { name: /^Model Fake/ })).toBeVisible();
	await page.getByLabel("Message").fill("half a thought");
	await openPanel(page, isMobile);
	await toggle(page, "Chat sessions").click();
	await expect(page.getByRole("heading", { name: "new chat" })).toBeVisible();
	await expect(page.getByLabel("Message")).toHaveValue("half a thought");
});

test("phone: the button never covers the last row", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone only");
	await page.goto("/#/new");
	await openPanel(page, isMobile);
	const rows = page.locator("pi-sidebar .row");
	await expect(rows.last()).toBeAttached();
	await rows.last().scrollIntoViewIfNeeded();
	await page.locator("pi-sidebar .groups").evaluate((el) => (el.scrollTop = el.scrollHeight));
	await expect
		.poll(async () => {
			const row = await rows.last().boundingBox();
			const btn = await newButton(page).boundingBox();
			return row && btn ? row.y + row.height <= btn.y : false;
		})
		.toBe(true);
});
