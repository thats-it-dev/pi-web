import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto("/");
	await page.waitForFunction(() => customElements.get("tk-shell"));
	expect(errors).toEqual([]);
});

test("defines all four elements", async ({ page }) => {
	for (const tag of ["tk-shell", "tk-header", "tk-sheet", "tk-toasts"]) {
		expect(await page.evaluate((t) => !!customElements.get(t), tag)).toBe(true);
	}
});

test("phone drawer opens from the header and closes on link or overlay", async ({ page }, info) => {
	test.skip(info.project.name !== "phone");
	const layout = page.locator("tk-shell .layout");
	await page.locator("tk-header .menu").click();
	await expect(layout).toHaveClass(/nav-open/);
	await page.locator("tk-shell a[href='']").click();
	await expect(layout).not.toHaveClass(/nav-open/);
	await page.locator("tk-header .menu").click();
	await expect(layout).toHaveClass(/nav-open/);
	await page.locator("tk-shell .overlay").click({ position: { x: 380, y: 300 } });
	await expect(layout).not.toHaveClass(/nav-open/);
});

test("sheet closes on Escape", async ({ page }) => {
	await page.getByRole("button", { name: "Open sheet" }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("toast shows its message", async ({ page }) => {
	await page.getByRole("button", { name: "Show toast" }).click();
	await expect(page.getByRole("status")).toContainText("Saved");
});
