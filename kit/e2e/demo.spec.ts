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

test("light-DOM .btn is styled from the kit tokens", async ({ page }) => {
	const s = await page.evaluate(() => {
		// Resolve --primary to rgb by painting it on a probe element.
		const probe = document.createElement("div");
		probe.style.backgroundColor = "var(--primary)";
		document.body.append(probe);
		const primary = getComputedStyle(probe).backgroundColor;
		probe.remove();
		const b = getComputedStyle(document.querySelector("button.btn:not(.ghost)")!);
		return { primary, bg: b.backgroundColor, radius: parseFloat(b.borderRadius) };
	});
	expect(s.bg).toBe(s.primary);
	expect(s.radius).toBeGreaterThan(0);
});

test("header actions slot sits at the right end of the title line", async ({ page }) => {
	const action = page.locator("tk-header button[slot='actions']");
	await expect(action).toBeVisible();
	const a = (await action.boundingBox())!;
	const t = (await page.locator("tk-header h1[slot='title']").boundingBox())!;
	expect(a.x).toBeGreaterThanOrEqual(t.x + t.width);
});

test("header action keeps its width and stays in view with a long title", async ({ page }) => {
	const action = page.locator("tk-header button[slot='actions']");
	const before = (await action.boundingBox())!;
	await page.locator("tk-header h1[slot='title']").evaluate((h) => (h.textContent = "A very long title ".repeat(30)));
	const after = (await action.boundingBox())!;
	const vw = page.viewportSize()!.width;
	expect(after.width).toBeCloseTo(before.width, 0);
	expect(after.x + after.width).toBeLessThanOrEqual(vw);
	await expect(action).toBeInViewport({ ratio: 1 });
});
