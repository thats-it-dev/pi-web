import { expect, test } from "@playwright/test";

test.skip(({ isMobile }) => isMobile, "desktop columns only");

const shell = "tk-shell";
const aside = 'tk-shell aside[aria-label="Details"]';
const nav = 'tk-shell aside[aria-label="Demo pages"]';

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		if (!sessionStorage.getItem("cleared")) {
			localStorage.clear();
			sessionStorage.setItem("cleared", "1");
		}
	});
});

test("both panels are columns that push the main area", async ({ page }) => {
	await page.goto("/");
	const a = page.locator(aside);
	await expect(a).toBeVisible();
	const ab = (await a.boundingBox())!;
	const vw = page.viewportSize()!.width;
	expect(Math.round(ab.x + ab.width)).toBe(vw);
	expect(Math.round(ab.width)).toBe(300);
	const mb = (await page.locator("tk-shell main").boundingBox())!;
	expect(mb.x + mb.width).toBeLessThanOrEqual(ab.x + 0.5);
});

test("hide and show the details column, remembered after reload", async ({ page }) => {
	await page.goto("/");
	await page.waitForFunction(() => customElements.get("tk-shell"));
	await page.locator(shell).evaluate((s: any) => s.hide("aside"));
	await expect.poll(async () => (await page.locator(aside).boundingBox())?.width ?? 0).toBe(0);
	await expect(page.locator(shell)).toHaveAttribute("aside-hidden", "");
	expect(await page.evaluate(() => localStorage.getItem("kit-demo:panels"))).toBe('{"nav":false,"aside":true}');
	await page.reload();
	await page.waitForFunction(() => customElements.get("tk-shell"));
	await expect.poll(async () => (await page.locator(aside).boundingBox())?.width ?? 0).toBe(0);
	await page.locator(shell).evaluate((s: any) => s.show("aside"));
	await expect.poll(async () => Math.round((await page.locator(aside).boundingBox())?.width ?? 0)).toBe(300);
});

test("nav-hidden in markup is the default when nothing is stored", async ({ page }) => {
	await page.goto("/?navhidden=1");
	await page.waitForFunction(() => customElements.get("tk-shell"));
	await expect.poll(async () => (await page.locator(nav).boundingBox())?.width ?? 0).toBe(0);
});

test("tk-panel-change reports hide and show", async ({ page }) => {
	await page.goto("/");
	await page.waitForFunction(() => customElements.get("tk-shell"));
	await page.evaluate(() => {
		(window as any).__ev = [];
		window.addEventListener("tk-panel-change", (e) => (window as any).__ev.push((e as CustomEvent).detail));
	});
	await page.locator(shell).evaluate((s: any) => s.hide("nav"));
	expect(await page.evaluate(() => (window as any).__ev)).toEqual([{ panel: "nav", open: false, docked: true }]);
	await page.locator(shell).evaluate((s: any) => s.show("nav"));
	expect(await page.evaluate(() => (window as any).__ev.at(-1))).toEqual({ panel: "nav", open: true, docked: true });
});
