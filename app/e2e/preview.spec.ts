import { type Page, expect, test } from "@playwright/test";

const PREVIEW = "e2e-preview";
const STOPPED = "e2e-preview-stopped";
const PROGRESS = "e2e-preview-progress"; // a to-do list too, and an hour-old preview
const LIVE = "e2e-preview-live"; // resumed by its test: its pi reports the preview running (the header dot)
const ASIDE = 'tk-shell aside[aria-label="Progress"]';

// The header's Progress button (its dot shows only for a running preview, which a session read from history has not).
const asideButton = (page: Page) => page.locator("pi-header").getByRole("button", { name: /^Progress/ });

// The aside opens by itself only for a preview under a minute old, so no test relies on that: wait for the session's
// preview to be known (the reply's card says so), then open or close the aside as needed.
async function setAside(page: Page, open: boolean) {
	const button = asideButton(page);
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
		await page.goto(`/#/s/${STOPPED}`);
		await expect(page.locator("pi-messages")).toContainText("show me the app"); // the session has loaded
		await expect(page.locator("pi-preview-panel")).toHaveCount(0);
		await expect(page.locator("pi-header .badge")).toHaveCount(0);
	});

	// The dot says a preview is running: a session read from history (its preview server long gone with its pi) has
	// none; one whose pi reports the preview status has it.
	test("the header dot shows only while the session's preview is running", async ({ page }) => {
		await page.goto(`/#/s/${PREVIEW}`);
		await expect(page.locator("pi-messages").getByRole("link", { name: "Open preview" })).toBeVisible();
		await expect(page.locator("pi-header .badge")).toHaveCount(0);
		await expect(asideButton(page)).not.toHaveAccessibleName(/preview open/);

		await page.goto(`/#/s/${LIVE}`);
		await expect(page.locator("pi-messages").getByRole("link", { name: "Open preview" })).toBeVisible();
		await expect(page.locator("pi-header .badge")).toHaveCount(0); // history until its pi runs
		const r = await page.evaluate(async (id) => (await fetch(`/api/sessions/${id}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "attach" }) })).status, LIVE);
		expect(r).toBe(200);
		await expect(page.locator("pi-header .badge")).toHaveText("•");
		await expect(asideButton(page)).toHaveAccessibleName(/^Progress, preview open/);
	});

	test("the card in the reply focuses the tab; pop-out is a new-tab link", async ({ page }) => {
		await page.goto(`/#/s/${PREVIEW}`);
		await expect(page.locator("pi-messages").getByRole("link", { name: "Open preview" })).toBeVisible(); // the preview is known
		await page.locator("tk-shell").evaluate((s: any) => s.hide("aside"));
		await page.locator("pi-messages").getByRole("link", { name: "Open preview" }).click();
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

	// iPad landscape: the Preview tab docks the aside; the Progress tab is a drawer again, with its history entry.
	test("at 1100px the Preview tab docks the aside and Progress is a drawer again", async ({ page }) => {
		await page.setViewportSize({ width: 1100, height: 800 });
		// The Preview tab was the last one picked on this device (in some other chat).
		await page.addInitScript(() => localStorage.setItem("pi-web:aside-tab", "preview"));
		await page.goto(`/#/s/${PROGRESS}`);
		const shell = page.locator("tk-shell");
		const aside = page.locator(ASIDE);
		const nav = page.locator('tk-shell aside[aria-label="Sessions"]');
		const button = asideButton(page);
		await expect(button).toBeVisible();
		await expect(page.locator("pi-messages").getByRole("link", { name: "Open preview" })).toBeVisible();
		// An hour-old preview, reopened: no takeover, even when the Preview tab was the last one picked on this device
		// (the stored tab applies once this chat's preview is used). The aside stays a closed drawer on the Progress tab.
		await expect(shell).not.toHaveAttribute("dock-aside", "");
		await expect(button).toHaveAttribute("aria-expanded", "false");
		const before = await page.evaluate(() => history.length);

		await button.click();
		await expect(aside).toHaveClass(/drawer/);
		await page.locator("pi-aside").getByRole("button", { name: "Preview" }).click();
		await expect(shell).toHaveAttribute("dock-aside", "");
		await expect(aside).not.toHaveClass(/drawer/);
		await expect.poll(async () => Math.round((await aside.boundingBox())!.width)).toBe(300);
		await expect.poll(async () => Math.round((await page.locator("tk-shell main").boundingBox())!.width)).toBeGreaterThanOrEqual(360);
		// 280 + 300 + 360 fit in 1100, so the kit keeps the nav docked (it un-docks only when they don't): no overflow either way.
		const navBox = await nav.boundingBox();
		const navDocked = !/drawer/.test((await nav.getAttribute("class")) ?? "") && (navBox?.width ?? 0) > 0;
		if (navDocked) expect(Math.round(navBox!.width) + 300 + 360).toBeLessThanOrEqual(1100);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1100);
		await expect(page.locator("pi-preview-panel iframe")).toBeVisible();
		// Docking took the drawer's history entry back off.
		await expect.poll(() => page.evaluate(() => history.state?.piProgress ?? null)).toBeNull();

		await page.locator("pi-aside").getByRole("button", { name: "Progress" }).click();
		await expect(shell).not.toHaveAttribute("dock-aside", "");
		await expect(aside).toHaveClass(/drawer/);
		await expect(aside).toHaveClass(/open/);
		await expect(page.locator("pi-progress-panel")).toBeVisible();
		// The chat is inert behind an open drawer, so Escape closes it; then the header button toggles it as before.
		await page.keyboard.press("Escape");
		await expect(button).toHaveAttribute("aria-expanded", "false");
		await button.click();
		await expect(button).toHaveAttribute("aria-expanded", "true");
		await page.keyboard.press("Escape");
		await expect(button).toHaveAttribute("aria-expanded", "false");
		// No stray history entry: we are on the chat's own entry, and Back leaves the chat.
		await expect.poll(() => page.evaluate(() => history.state?.piProgress ?? null)).toBeNull();
		expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(before + 1); // a forward entry may remain
		await page.goBack();
		expect(page.url()).not.toContain(PROGRESS);
	});
});

test.describe("phone", () => {
	test.skip(({ isMobile }) => !isMobile);

	test("the reply has an Open button and no iframe anywhere", async ({ page, context }) => {
		await page.goto(`/#/s/${PREVIEW}`);
		const open = page.locator("pi-messages").getByRole("link", { name: "Open preview" });
		await expect(open).toHaveAttribute("target", "_blank");
		await expect(page.locator("iframe")).toHaveCount(0);
		// A fresh preview never slides the drawer over the reply on a phone: the card and the header dot say it.
		const button = asideButton(page);
		await expect(button).toBeVisible();
		await page.waitForTimeout(500); // the app opens the aside a render after the preview lands: give it the chance
		await expect(button).toHaveAttribute("aria-expanded", "false");
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
