import { expect, test } from "@playwright/test";

const navBorder = (page: import("@playwright/test").Page) =>
	page.locator('tk-shell aside[aria-label="Demo pages"]').evaluate((e) => getComputedStyle(e).borderRightWidth);

test("phone nav drawer keeps its right border", async ({ page }, info) => {
	test.skip(info.project.name !== "phone");
	await page.goto("/");
	await page.waitForFunction(() => customElements.get("tk-shell"));
	expect(await navBorder(page)).toBe("1px");
});

test("docked nav keeps its right border, hidden nav has none", async ({ page }, info) => {
	test.skip(info.project.name !== "desktop");
	await page.goto("/");
	await page.waitForFunction(() => customElements.get("tk-shell"));
	expect(await navBorder(page)).toBe("1px");
	await page.locator("tk-shell").evaluate((s: any) => s.hide("nav"));
	await expect.poll(() => navBorder(page)).toBe("0px");
});
