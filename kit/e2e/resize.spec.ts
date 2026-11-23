import { expect, test } from "@playwright/test";

const shell = "tk-shell";
const aside = 'tk-shell aside[aria-label="Details"]';
const nav = 'tk-shell aside[aria-label="Demo pages"]';
const main = "tk-shell main";
const width = async (page: any, sel: string) => Math.round((await page.locator(sel).boundingBox())!.width);

test.describe("resizable aside", () => {
	test.skip(({ isMobile }) => isMobile, "desktop columns only");
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			if (!sessionStorage.getItem("cleared")) {
				localStorage.clear();
				sessionStorage.setItem("cleared", "1");
			}
		});
		await page.setViewportSize({ width: 1600, height: 900 });
		await page.goto("/");
		await page.waitForFunction(() => customElements.get("tk-shell"));
	});

	test("dragging the handle widens the aside and the width survives a reload", async ({ page }) => {
		const hb = (await page.locator("tk-shell .handle").boundingBox())!;
		await page.mouse.move(hb.x + hb.width / 2, hb.y + 200);
		await page.mouse.down();
		await page.mouse.move(hb.x + hb.width / 2 - 200, hb.y + 200, { steps: 5 });
		await page.mouse.up();
		await expect.poll(() => width(page, aside)).toBe(500);
		expect(await page.evaluate(() => localStorage.getItem("kit-demo:panels:aside-w"))).toBe("500");
		await page.reload();
		await page.waitForFunction(() => customElements.get("tk-shell"));
		await expect.poll(() => width(page, aside)).toBe(500);
	});

	test("the chat floor wins when the window shrinks", async ({ page }) => {
		await page.evaluate(() => localStorage.setItem("kit-demo:panels:aside-w", "900"));
		await page.reload();
		await page.waitForFunction(() => customElements.get("tk-shell"));
		await page.setViewportSize({ width: 1300, height: 900 });
		await expect.poll(() => width(page, aside)).toBe(1300 - 280 - 360);
		await expect.poll(() => width(page, main)).toBeGreaterThanOrEqual(360);
	});

	test("double-click resets to 300 and clears the stored width", async ({ page }) => {
		await page.evaluate(() => localStorage.setItem("kit-demo:panels:aside-w", "500"));
		await page.reload();
		await page.waitForFunction(() => customElements.get("tk-shell"));
		await expect.poll(() => width(page, aside)).toBe(500);
		await page.locator("tk-shell .handle").dblclick();
		await expect.poll(() => width(page, aside)).toBe(300);
		expect(await page.evaluate(() => localStorage.getItem("kit-demo:panels:aside-w"))).toBe(null);
	});

	test("half and full sizes", async ({ page }) => {
		await page.locator("#size-half").click();
		await expect.poll(() => width(page, aside)).toBe(660);
		await page.locator("#size-full").click();
		await expect.poll(() => width(page, aside)).toBe(1600 - 280 - 48);
		await expect.poll(() => width(page, main)).toBe(48);
		await expect(page.locator(shell)).toHaveAttribute("aside-size", "full");
		await expect(page.locator(shell)).toHaveAttribute("aside-full", "");
		await page.locator("#size-default").click();
		await expect.poll(() => width(page, aside)).toBe(300);
		await expect(page.locator(shell)).not.toHaveAttribute("aside-full", "");
	});

	test("dock-aside at 900px docks the aside and un-docks the nav", async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 900 });
		await expect(page.locator(aside)).toHaveClass(/drawer/);
		await page.locator("#dock-toggle").click();
		await expect.poll(() => width(page, aside)).toBe(300);
		await expect(page.locator(aside)).not.toHaveClass(/drawer/);
		await expect(page.locator(nav)).toHaveClass(/drawer/);
		await expect.poll(() => width(page, main)).toBeGreaterThanOrEqual(360);
	});

	test("full needs a docked aside: un-docking drops aside-full and the drawer keeps its own width", async ({ page }) => {
		await page.setViewportSize({ width: 1000, height: 900 });
		await page.locator("#dock-toggle").click();
		await page.locator("#size-full").click();
		await expect(page.locator(shell)).toHaveAttribute("aside-full", "");
		await page.locator("#dock-toggle").click();
		await expect(page.locator(shell)).not.toHaveAttribute("aside-full", "");
		await page.locator(shell).evaluate((s: any) => s.show("aside"));
		await expect(page.locator(aside)).toHaveClass(/drawer/);
		// min(85vw, 360px) at 1000px; the box is a pixel wider for the drawer's border.
		await expect(page.locator(aside)).toHaveCSS("width", "360px");
	});

	test("a shell without resizable draws no handle", async ({ page }) => {
		await expect(page.locator("tk-shell .handle")).toHaveCount(1);
		await page.locator(shell).evaluate((s) => s.removeAttribute("resizable"));
		await expect(page.locator("tk-shell .handle")).toHaveCount(0);
	});

	test("without sizing the shell leaves an app's --aside-w alone", async ({ page }) => {
		await page.locator(shell).evaluate((s: HTMLElement) => {
			s.removeAttribute("resizable");
			s.style.setProperty("--aside-w", "420px");
		});
		await expect.poll(() => width(page, aside)).toBe(420);
	});
});

test.describe("fullscreen drawer", () => {
	test.skip(({ isMobile }) => !isMobile, "phone only");
	test("aside-fullscreen makes the details drawer the whole width", async ({ page }) => {
		await page.goto("/");
		await page.waitForFunction(() => customElements.get("tk-shell"));
		await page.locator("#fullscreen-toggle").click();
		await page.locator(shell).evaluate((s: any) => s.show("aside"));
		// 100vw is fractional on a 2.625-dpr phone, so the rounded box can be 1px over the integer viewport width.
		const vw = await page.evaluate(() => window.innerWidth);
		await expect.poll(() => width(page, aside)).toBeGreaterThanOrEqual(vw);
		await expect.poll(() => width(page, aside)).toBeLessThanOrEqual(vw + 1);
		await expect.poll(async () => Math.abs((await page.locator(aside).boundingBox())!.x)).toBeLessThanOrEqual(1);
	});
});
