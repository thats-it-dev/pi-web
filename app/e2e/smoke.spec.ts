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

test("desktop: start a session, stream a reply, switch model, rename with a slash command", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	await startSession(page);
	const input = page.getByLabel("Message");
	await input.fill("hi");
	await input.press("Enter");
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await expect(page.getByRole("button", { name: "Session stats" })).toContainText("/ 1k"); // fake-a has a 1000-token window

	await page.getByRole("button", { name: /^Model Fake A/ }).click();
	await page.getByRole("option", { name: /Fake B/ }).click();
	await expect(page.getByRole("button", { name: /^Model Fake B/ })).toBeVisible();

	await input.fill("/na");
	await expect(page.getByRole("listbox", { name: "Commands" })).toContainText("/name");
	await input.press("Enter");
	await expect(input).toHaveValue("/name ");
	await input.pressSequentially("e2e run");
	await input.press("Enter");
	await expect(page.locator("pi-header h1")).toHaveText("e2e run");
	await expect(page.locator("pi-sidebar")).toContainText("e2e run");
});

test("phone: send with the button, then find the session from the menu", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone flow");
	await startSession(page);
	await page.getByLabel("Message").fill("hello from the phone");
	await page.getByRole("button", { name: "send" }).click();
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await page.locator("pi-header").getByRole("button", { name: "Open sessions" }).click();
	await expect(page.locator("pi-sidebar")).toContainText("hello from the phone");
});
