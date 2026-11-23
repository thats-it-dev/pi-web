import { type Page, expect, test } from "@playwright/test";

const PREVIEW = "e2e-preview";
const STOPPED = "e2e-preview-stopped";
const ASIDE = 'tk-shell aside[aria-label="Progress"]';

// The aside opens by itself only for a preview under a minute old, so no test relies on that: wait for the session's
// preview to be known (the header says so), then open or close the aside as needed.
async function setAside(page: Page, open: boolean) {
	const button = page.locator("pi-header").getByRole("button", { name: /Progress, preview open/ });
	await expect(button).toBeVisible();
	await expect(page.locator("pi-messages").getByRole("link", { name: "Open preview" })).toBeVisible();
	if ((await button.getAttribute("aria-expanded")) === (open ? "true" : "false")) return;
	if (open) await button.click();
	else await page.keyboard.press("Escape");
	await expect(button).toHaveAttribute("aria-expanded", open ? "true" : "false");
}

test.describe("desktop", () => {
	test.skip(({ isMobile }) => isMobile);

	test("the Preview tab shows the iframe, viewport presets and status; stop hides it", async ({ page }) => {
		await page.goto(`/#/s/${PREVIEW}`);
		await setAside(page, true);
		const panel = page.locator("pi-preview-panel"); // slotted into the aside, so not inside the aside element itself
		await expect(panel.locator("iframe")).toHaveAttribute("src", "http://localhost:5173/");
		await expect(panel.getByRole("button", { name: "390" })).toBeVisible();
		await panel.getByRole("button", { name: "390" }).click();
		// 390 is the iframe's layout width; in the default 300px aside it is scaled down to fit.
		await expect(panel.locator("iframe")).toHaveCSS("width", "390px");
		await expect(panel.locator(".status")).toContainText("fret");
		await expect(page.locator("pi-header .badge")).toHaveText("•");
		await page.goto(`/#/s/${STOPPED}`);
		await expect(page.locator("pi-messages")).toContainText("show me the app"); // the session has loaded
		await expect(page.locator("pi-preview-panel")).toHaveCount(0);
		await expect(page.locator("pi-header .badge")).toHaveCount(0);
	});

	test("the card in the reply focuses the tab; pop-out is a new-tab link", async ({ page }) => {
		await page.goto(`/#/s/${PREVIEW}`);
		await expect(page.locator("pi-messages").getByRole("link", { name: "Open preview" })).toBeVisible(); // the preview is known
		await page.locator("tk-shell").evaluate((s: any) => s.hide("aside"));
		await page.getByRole("link", { name: "Open preview" }).click();
		await expect(page.locator("pi-preview-panel iframe")).toBeVisible();
		await expect(page.locator('pi-preview-panel a[aria-label="Open in a new tab"]')).toHaveAttribute("target", "_blank");
	});

	test("snap cycles half and full; full leaves a 48px strip", async ({ page }) => {
		await page.goto(`/#/s/${PREVIEW}`);
		await setAside(page, true);
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
		await setAside(page, false); // a fresh preview may have opened the drawer over the reply
		const [popup] = await Promise.all([context.waitForEvent("page"), open.click()]);
		expect(popup.url()).toBe("http://localhost:5173/");
	});
});

test.describe("tablet", () => {
	test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "sets its own viewport; once is enough"));
	test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

	test("the Preview tab is full screen with Back to chat", async ({ page }) => {
		await page.goto(`/#/s/${PREVIEW}`);
		await setAside(page, true); // full screen
		await expect(page.locator("pi-preview-panel iframe")).toBeVisible();
		const asideOff = async () => Math.abs((await page.locator(ASIDE).boundingBox())!.width - 820);
		await expect.poll(asideOff).toBeLessThanOrEqual(1);
		await page.getByRole("button", { name: "Back to chat" }).click();
		await expect(page.locator("pi-preview-panel iframe")).toBeHidden();
		// The header button brings it back.
		await setAside(page, true);
		await expect(page.locator("pi-preview-panel iframe")).toBeVisible();
		await expect.poll(asideOff).toBeLessThanOrEqual(1);
	});
});
