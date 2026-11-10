import { expect, test } from "@playwright/test";

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

test.describe("desktop columns", () => {
	test.skip(({ isMobile }) => isMobile, "desktop columns only");

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
});

const ready = async (page: import("@playwright/test").Page, url = "/") => {
	await page.goto(url);
	await page.waitForFunction(() => customElements.get("tk-shell"));
};
const call = (page: import("@playwright/test").Page, method: string, panel: string) =>
	page.locator(shell).evaluate((s: any, [m, p]) => s[m](p), [method, panel]);
const overlay = "tk-shell .overlay";
// Is the focused element (following open shadow roots) inside the given light-DOM selector?
const focusInside = (page: import("@playwright/test").Page, sel: string) =>
	page.evaluate((sel) => {
		let a = document.activeElement;
		while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
		return !!a && !!a.closest(sel);
	}, sel);

test("phone: both panels are drawers; tap the dim or Escape closes", async ({ page }, info) => {
	test.skip(info.project.name !== "phone");
	await ready(page);
	await call(page, "show", "nav");
	await expect(page.locator(nav)).toBeInViewport({ ratio: 1 });
	await expect(page.locator(aside)).not.toBeInViewport();
	await expect(page.locator(aside)).toBeHidden();
	await call(page, "show", "aside");
	await expect(page.locator(nav)).toBeHidden();
	await expect(page.locator(aside)).toBeInViewport({ ratio: 1 });
	const vw = page.viewportSize()!.width;
	const ab = (await page.locator(aside).boundingBox())!;
	expect(Math.round(ab.x + ab.width)).toBe(vw);
	await page.locator(overlay).click({ position: { x: 10, y: 300 } });
	await expect(page.locator(aside)).toBeHidden();
	await call(page, "show", "aside");
	await expect(page.locator(aside)).toBeInViewport({ ratio: 1 });
	await page.keyboard.press("Escape");
	await expect(page.locator(aside)).toBeHidden();
	await expect(page.locator(overlay)).toBeHidden();
});

test("phone: a closed drawer cannot be reached with Tab", async ({ page }, info) => {
	test.skip(info.project.name !== "phone");
	await ready(page);
	for (let i = 0; i < 15; i++) {
		await page.keyboard.press("Tab");
		expect(await focusInside(page, "[slot=nav], [slot=aside]")).toBe(false);
	}
});

test("phone: focus moves into an opened drawer and back to its opener", async ({ page }, info) => {
	test.skip(info.project.name !== "phone");
	await ready(page);
	const opener = page.locator("#show-toast");
	await opener.evaluate((b: HTMLElement) => {
		b.focus();
		b.dispatchEvent(new CustomEvent("tk-show-panel", { detail: { panel: "aside" }, bubbles: true, composed: true }));
	});
	await expect.poll(() => focusInside(page, "[slot=aside]")).toBe(true);
	await page.keyboard.press("Escape");
	await expect(page.locator(aside)).toBeHidden();
	await expect(opener).toBeFocused();	// following a link in the nav drawer returns focus to the header's menu button
	await page.locator("tk-header .menu").click();
	await expect.poll(() => focusInside(page, "[slot=nav]")).toBe(true);
	await page.locator("tk-shell a[href='#b']").click();
	await expect(page.locator(nav)).toBeHidden();
	await expect(page.locator("tk-header .menu")).toBeFocused();
});

test("mid width with both panels: nav is a column, details a drawer", async ({ page }, info) => {
	test.skip(info.project.name !== "desktop");
	await page.setViewportSize({ width: 1000, height: 800 });
	await ready(page);
	await expect.poll(async () => Math.round((await page.locator(nav).boundingBox())?.width ?? 0)).toBe(280);
	await expect(page.locator(aside)).toBeHidden();
	await expect(page.locator(overlay)).toBeHidden();
	await call(page, "show", "aside");
	await expect(page.locator(aside)).toBeInViewport({ ratio: 1 });
	const ab = (await page.locator(aside).boundingBox())!;
	expect(Math.round(ab.x + ab.width)).toBe(1000);
	await expect(page.locator(overlay)).toBeVisible();
	// a drawer floats over the page: the main area keeps its width
	const mb = (await page.locator("tk-shell main").boundingBox())!;
	expect(Math.round(mb.x + mb.width)).toBe(1000);
});

test("mid width with only details: it is a column", async ({ page }, info) => {
	test.skip(info.project.name !== "desktop");
	await page.setViewportSize({ width: 1000, height: 800 });
	await ready(page, "/?nav=0");
	await expect.poll(async () => Math.round((await page.locator(aside).boundingBox())?.width ?? 0)).toBe(300);
	const mb = (await page.locator("tk-shell main").boundingBox())!;
	expect(Math.round(mb.x)).toBe(0);
	expect(Math.round(mb.x + mb.width)).toBe(700);
	await expect(page.locator(overlay)).toBeHidden();
});

test("widening the window closes an open drawer and nothing stays inert", async ({ page }, info) => {
	test.skip(info.project.name !== "desktop");
	await page.setViewportSize({ width: 412, height: 800 });
	await ready(page);
	await call(page, "show", "aside");
	await expect(page.locator(aside)).toBeInViewport({ ratio: 1 });
	await page.setViewportSize({ width: 1280, height: 800 });
	await expect(page.locator(overlay)).toBeHidden();
	await expect.poll(() =>
		page.locator(shell).evaluate((s) =>
			[...s.shadowRoot!.querySelectorAll("[inert]")].filter((e) => e.getBoundingClientRect().width > 0).length,
		),
	).toBe(0);
	await page.getByRole("button", { name: "Show toast" }).click();
	await expect(page.getByRole("status")).toContainText("Saved");
});

test("a sheet opened from a drawer is usable and takes Escape first", async ({ page }, info) => {
	test.skip(info.project.name !== "phone");
	await ready(page);
	await call(page, "show", "aside");
	await page.locator("#open-sheet-2").click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.getByRole("button", { name: "Close" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.locator(aside)).toBeInViewport({ ratio: 1 });
	await page.locator("#open-sheet-2").click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.locator(aside)).toBeInViewport({ ratio: 1 });
	await page.keyboard.press("Escape");
	await expect(page.locator(aside)).toBeHidden();
});

test("an app without a details panel looks as before", async ({ page }, info) => {
	await ready(page, "/?aside=0");
	const vw = page.viewportSize()!.width;
	const a = page.locator(aside);
	// no empty "Details" landmark or tab stop
	await expect(a).toBeHidden();
	expect(await page.getByRole("complementary", { name: "Details" }).count()).toBe(0);
	if (info.project.name === "desktop") {
		expect((await a.boundingBox())?.width ?? 0).toBe(0);
		const mb = (await page.locator("tk-shell main").boundingBox())!;
		expect(Math.round(mb.x)).toBe(280);
		expect(Math.round(mb.x + mb.width)).toBe(vw);
		return;
	}
	await page.locator("tk-header .menu").click();
	await expect(page.locator(nav)).toBeInViewport({ ratio: 1 });
	await page.locator("tk-shell a[href='#b']").click();
	await expect(page.locator(nav)).toBeHidden();
});

test("tk-*-panel events with a missing or unknown panel are ignored", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await ready(page);
	await page.locator("#show-toast").evaluate((b) => {
		for (const type of ["tk-show-panel", "tk-hide-panel", "tk-toggle-panel"]) {
			b.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
			b.dispatchEvent(new CustomEvent(type, { detail: { panel: "bogus" }, bubbles: true, composed: true }));
		}
	});
	expect(errors).toEqual([]);
});

test("a sheet removed from the page while open stops counting: the drawer traps focus again", async ({ page }, info) => {
	test.skip(info.project.name !== "phone");
	await ready(page);
	await call(page, "show", "aside");
	await page.locator("#open-sheet-2").click();
	await expect(page.getByRole("dialog")).toBeVisible();
	const mainInert = () => page.locator(shell).evaluate((s) => s.shadowRoot!.querySelector("main")!.inert);
	await expect.poll(mainInert).toBe(false);
	await page.locator("#sheet").evaluate((el) => el.remove());
	await expect.poll(mainInert).toBe(true);
	await page.keyboard.press("Escape");
	await expect(page.locator(aside)).toBeHidden();
});

test.describe("header buttons", () => {
	test("header buttons toggle each panel and report aria-expanded", async ({ page, isMobile }) => {
		test.skip(isMobile, "desktop columns only");
		await page.goto("/");
		await page.waitForFunction(() => customElements.get("tk-shell"));
		for (const [btn, panel] of [["tk-header .aside-toggle", aside], ["tk-header .menu", nav]] as const) {
			await expect(page.locator(btn)).toHaveAttribute("aria-expanded", "true");
			await page.locator(btn).click();
			await expect(page.locator(btn)).toHaveAttribute("aria-expanded", "false");
			await expect.poll(async () => (await page.locator(panel).boundingBox())?.width ?? 0).toBe(0);
			await page.locator(btn).click();
			await expect(page.locator(btn)).toHaveAttribute("aria-expanded", "true");
			await expect.poll(async () => (await page.locator(panel).boundingBox())?.width ?? 0).toBeGreaterThan(200);
		}
	});

	test("phone: menu opens nav, panel button opens details, badge shows", async ({ page, isMobile }) => {
		test.skip(!isMobile, "phone only");
		await page.goto("/");
		await page.waitForFunction(() => customElements.get("tk-shell"));
		await page.locator("tk-header .menu").click();
		await expect(page.locator("tk-header .menu")).toHaveAttribute("aria-expanded", "true");
		await expect(page.locator(nav)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.locator("tk-header .menu")).toHaveAttribute("aria-expanded", "false");
		const btn = page.locator("tk-header .aside-toggle");
		await expect(btn).toContainText("3/7");
		await btn.click();
		await expect(btn).toHaveAttribute("aria-expanded", "true");
		await expect(page.locator(aside)).toBeVisible();
	});

	test("a header outside a shell has no panel buttons", async ({ page, isMobile }) => {
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(String(e)));
		page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
		await page.goto("/bare.html");
		await page.waitForFunction(() => customElements.get("tk-header"));
		await expect(page.locator("tk-header .aside-toggle")).toHaveCount(0);
		if (!isMobile) await expect(page.locator("tk-header .menu")).toBeHidden();
		expect(errors).toEqual([]);
	});

	test("no details content means no details button", async ({ page }) => {
		await page.goto("/?aside=0");
		await page.waitForFunction(() => customElements.get("tk-shell"));
		await expect(page.locator("tk-header .menu")).toHaveCount(1);
		await expect(page.locator("tk-header .aside-toggle")).toHaveCount(0);
	});

	test("a removed header is released and a re-added one gets panels again", async ({ page }) => {
		await page.goto("/");
		await page.waitForFunction(() => customElements.get("tk-shell"));
		await expect(page.locator("tk-header .menu")).toHaveCount(1);
		await page.evaluate(() => {
			const h = document.querySelector("tk-header") as any;
			(window as any).__h = h;
			h.remove();
		});
		expect(await page.evaluate(() => (window as any).__h.panels)).toBeNull();
		// A state change while detached must not reach it.
		await page.evaluate(() => (document.querySelector("tk-shell") as any).hide("aside"));
		await page.waitForTimeout(100);
		expect(await page.evaluate(() => (window as any).__h.panels)).toBeNull();
		await page.evaluate(() => document.querySelector("tk-shell")!.prepend((window as any).__h));
		await expect.poll(() => page.evaluate(() => !!(window as any).__h.panels)).toBe(true);
		await expect(page.locator("tk-header .aside-toggle")).toHaveCount(1);
	});

	test("a header nested in another component's shadow root gets buttons", async ({ page }) => {
		await page.goto("/shadow.html");
		await page.waitForFunction(() => customElements.get("tk-shell"));
		await expect(page.locator("x-wrap tk-header .menu")).toHaveCount(1);
		await expect(page.locator("x-wrap tk-header .aside-toggle")).toHaveCount(1);
	});

	test("icons draw: svg children are in the SVG namespace", async ({ page }) => {
		await page.goto("/");
		await page.waitForFunction(() => customElements.get("tk-shell"));
		const width = (sel: string) => page.locator(sel).first().evaluate((el: any) => el.getBBox().width);
		expect(await width("tk-header .aside-toggle svg rect")).toBeGreaterThan(0);
		expect(await width("tk-header .menu svg rect, tk-header .menu svg path")).toBeGreaterThan(0);
		await page.locator("#open-sheet").click();
		expect(await width("tk-sheet .x svg path")).toBeGreaterThan(0);
	});
});
