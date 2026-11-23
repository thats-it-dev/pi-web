import { expect, test } from "@playwright/test";

const PREVIEW = "e2e-preview";
const STOPPED = "e2e-preview-stopped";
const ASIDE = 'tk-shell aside[aria-label="Progress"]';

test.describe("desktop", () => {
	test.skip(({ isMobile }) => isMobile);

	test("the Preview tab shows the iframe, viewport presets and status; stop hides it", async ({ page }) => {
		await page.goto(`/#/s/${PREVIEW}`);
		const panel = page.locator("pi-preview-panel"); // slotted into the aside, so not inside the aside element itself
		await expect(panel.locator("iframe")).toHaveAttribute("src", "http://localhost:5173/");
		await expect(panel.getByRole("button", { name: "390" })).toBeVisible();
		await panel.getByRole("button", { name: "390" }).click();
		// 390 is the iframe's layout width; in the default 300px aside it is scaled down to fit.
		await expect(panel.locator("iframe")).toHaveCSS("width", "390px");
		await expect(panel.locator(".status")).toContainText("fret");
		await expect(page.locator("pi-header .badge")).toHaveText("•");
		await page.goto(`/#/s/${STOPPED}`);
		await expect(page.locator("pi-preview-panel")).toHaveCount(0);
	});

	test("the card in the reply focuses the tab; pop-out is a new-tab link", async ({ page }) => {
		await page.goto(`/#/s/${PREVIEW}`);
		await page.locator("tk-shell").evaluate((s: any) => s.hide("aside"));
		await page.getByRole("link", { name: "Open preview" }).click();
		await expect(page.locator("pi-preview-panel iframe")).toBeVisible();
		await expect(page.locator('pi-preview-panel a[aria-label="Open in a new tab"]')).toHaveAttribute("target", "_blank");
	});

	test("snap cycles half and full; full leaves a 48px strip", async ({ page }) => {
		await page.goto(`/#/s/${PREVIEW}`);
		const aside = page.locator(ASIDE);
		const panel = page.locator("pi-preview-panel");
		const width = async () => Math.round((await aside.boundingBox())!.width);
		const vw = page.viewportSize()!.width;
		await expect(panel.locator("iframe")).toBeVisible();
		await panel.getByRole("button", { name: "Resize preview" }).click();
		await expect.poll(width).toBe(Math.round((vw - 280) / 2));
		await panel.getByRole("button", { name: "Resize preview" }).click();
		await expect.poll(width).toBe(vw - 280 - 48);
		const back = page.getByRole("button", { name: "Back to chat" }).first();
		await expect(back).toBeVisible();
		await back.click();
		await expect.poll(width).toBe(Math.round((vw - 280) / 2));
	});
});

test.describe("phone", () => {
	test.skip(({ isMobile }) => !isMobile);

	test("the reply has an Open button and no iframe anywhere", async ({ page, context }) => {
		await page.goto(`/#/s/${PREVIEW}`);
		const open = page.locator("pi-messages").getByRole("link", { name: "Open preview" });
		await expect(open).toHaveAttribute("target", "_blank");
		await expect(page.locator("iframe")).toHaveCount(0);
		// The fresh preview opened the drawer (a card, no iframe); close it so it doesn't sit over the reply.
		await expect(page.locator("pi-header").getByRole("button", { name: /Progress/ })).toHaveAttribute("aria-expanded", "true");
		await page.keyboard.press("Escape");
		await expect(page.locator("pi-header").getByRole("button", { name: /Progress/ })).toHaveAttribute("aria-expanded", "false");
		const [popup] = await Promise.all([context.waitForEvent("page"), open.click()]);
		expect(popup.url()).toBe("http://localhost:5173/");
	});
});

test.describe("tablet", () => {
	test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "sets its own viewport; once is enough"));
	test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

	test("the Preview tab is full screen with Back to chat", async ({ page }) => {
		await page.goto(`/#/s/${PREVIEW}`);
		// A fresh preview opens the drawer by itself: full screen, with the header button underneath.
		await expect(page.locator("pi-preview-panel iframe")).toBeVisible();
		const asideOff = async () => Math.abs((await page.locator(ASIDE).boundingBox())!.width - 820);
		await expect.poll(asideOff).toBeLessThanOrEqual(1);
		await page.getByRole("button", { name: "Back to chat" }).click();
		await expect(page.locator("pi-preview-panel iframe")).toBeHidden();
		// The header button brings it back.
		await page.getByRole("button", { name: /Progress/ }).click();
		await expect(page.locator("pi-preview-panel iframe")).toBeVisible();
		await expect.poll(asideOff).toBeLessThanOrEqual(1);
	});
});
