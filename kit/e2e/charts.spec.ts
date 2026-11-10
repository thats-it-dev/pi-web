import { expect, test, type Page } from "@playwright/test";

// Every chart element on the demo page. Later tasks append their tags here so the text-size test covers them.
const CHART_TAGS = ["tk-stat", "tk-sparkline"];

/** Computed font-size (px) of every element that has direct text, walking open shadow roots under `selector`. */
export async function textSizes(page: Page, selector: string): Promise<number[]> {
	return page.evaluate((sel) => {
		const out: number[] = [];
		const walk = (el: Element) => {
			if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) out.push(parseFloat(getComputedStyle(el).fontSize));
			for (const c of el.children) walk(c);
			if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c);
		};
		document.querySelectorAll(sel).forEach(walk);
		return out;
	}, selector);
}

// On the phone the details column is a closed drawer; open it so its tiles have a size.
const openAside = async (page: Page) => {
	await page.evaluate(() => (document.querySelector("tk-shell") as any).show("aside"));
};

const ready = async (page: Page, url = "/charts.html") => {
	await page.goto(url);
	await page.waitForFunction(() => customElements.get("tk-stat") && customElements.get("tk-stats") && customElements.get("tk-sparkline"));
	await page.waitForFunction(() => customElements.get("tk-shell"));
};

// Resolve a CSS color token to the rgb() string the browser reports for computed styles.
const resolveColor = (page: Page, token: string) =>
	page.evaluate((t) => {
		const p = document.createElement("span");
		p.style.color = `var(${t})`;
		document.body.append(p);
		const c = getComputedStyle(p).color;
		p.remove();
		return c;
	}, token);

test("stat tiles: two columns, wide spans both", async ({ page }) => {
	await ready(page);
	await openAside(page);
	const stats = page.locator("[slot=aside] tk-stats").first();
	await expect(stats).toBeVisible();
	const sw = (await stats.boundingBox())!.width;
	const normal = (await stats.locator("tk-stat:not([wide])").first().boundingBox())!;
	const wide = (await stats.locator("tk-stat[wide]").first().boundingBox())!;
	expect(Math.abs(normal.width - (sw - 6) / 2)).toBeLessThanOrEqual(1);
	expect(Math.abs(wide.width - sw)).toBeLessThanOrEqual(1);
});

test("stat change colors only with good", async ({ page }) => {
	await ready(page);
	const stat = page.locator("#main-charts tk-stat").first();
	const change = stat.locator(".change");
	const color = () => change.evaluate((e) => getComputedStyle(e).color);
	await stat.evaluate((s: any) => { s.good = "up"; s.change = "+5 vs previous 2 weeks"; });
	await expect.poll(color).toBe(await resolveColor(page, "--success"));
	await stat.evaluate((s: any) => { s.change = "−3 vs previous 2 weeks"; });
	await expect.poll(color).toBe(await resolveColor(page, "--accent"));
	await stat.evaluate((s: any) => { s.good = ""; });
	await expect.poll(color).toBe(await resolveColor(page, "--text-secondary"));
});

test("stat value compacts numbers", async ({ page }) => {
	await ready(page);
	const stat = page.locator("#main-charts tk-stat").first();
	await stat.evaluate((s: any) => { s.value = 18400; s.unit = ""; });
	await expect(stat.locator(".value")).toHaveText("18.4K");
});

test("sparkline draws one path in --chart-1", async ({ page }) => {
	await ready(page);
	const paths = page.locator("#main-charts tk-sparkline").first().locator("path");
	await expect(paths).toHaveCount(1);
	expect(await paths.evaluate((p) => getComputedStyle(p).stroke)).toBe("rgb(230, 149, 0)");
	await ready(page, "/charts.html?theme=dark");
	expect(await page.locator("#main-charts tk-sparkline").first().locator("path").evaluate((p) => getComputedStyle(p).stroke)).toBe("rgb(255, 170, 0)");
});

test("no chart text under 12px", async ({ page }) => {
	await ready(page);
	await openAside(page);
	for (const tag of CHART_TAGS) {
		const sizes = await textSizes(page, tag);
		if (tag === "tk-stat") expect(sizes.length).toBeGreaterThan(0);
		for (const s of sizes) expect(s, tag).toBeGreaterThanOrEqual(12);
	}
});
