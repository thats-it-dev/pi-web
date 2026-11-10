import { expect, test, type Page } from "@playwright/test";

// Every chart element on the demo page. Later tasks append their tags here so the text-size test covers them.
const CHART_TAGS = ["tk-stat", "tk-sparkline", "tk-timeseries", "tk-bars", "tk-heatmap"];

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

// The time series charts: wait for the element and for the aside chart's first measured render.
const tsReady = async (page: Page, url = "/charts.html") => {
	await ready(page, url);
	await openAside(page);
	await page.waitForFunction(() => customElements.get("tk-timeseries"));
	await expect(page.locator("#ts-aside svg")).toHaveCount(1);
};

const fmtDay = (page: Page, key: string) =>
	page.evaluate((k) => {
		const [y, m, d] = k.split("-").map(Number);
		return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(y, m - 1, d, 12));
	}, key);

/** Runs of consecutive days where `ok(row)` holds. */
const runCount = (days: any[], ok: (r: any) => boolean) => days.reduce((n, r, i) => n + (ok(r) && !(i > 0 && ok(days[i - 1])) ? 1 : 0), 0);
const mCount = (d: string) => (d.match(/M/g) ?? []).length;

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
		if (tag === "tk-stat" || tag === "tk-timeseries" || tag === "tk-bars" || tag === "tk-heatmap") expect(sizes.length, tag).toBeGreaterThan(0);
		for (const s of sizes) expect(s, tag).toBeGreaterThanOrEqual(12);
	}
});

test("timeseries fits the aside without overflow", async ({ page }) => {
	await tsReady(page);
	const m = await page.locator("#ts-aside").evaluate((host) => {
		const svg = host.shadowRoot!.querySelector("svg")!;
		const cs = getComputedStyle(host);
		const content = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
		return { hs: host.scrollWidth, hc: host.clientWidth, ss: svg.scrollWidth, sc: svg.clientWidth, sw: svg.getBoundingClientRect().width, content };
	});
	expect(m.hc).toBeGreaterThan(100);
	expect(m.hs).toBeLessThanOrEqual(m.hc);
	expect(m.ss).toBeLessThanOrEqual(m.sc);
	expect(Math.abs(m.sw - m.content)).toBeLessThanOrEqual(1);
});

test("missing days break the line", async ({ page }) => {
	await tsReady(page);
	const days: any[] = await page.evaluate(() => (window as any).demo.days);
	const finite = (k: string) => (r: any) => typeof r[k] === "number" && Number.isFinite(r[k]);
	const s1 = await page.locator("#ts-aside path.line.s1").getAttribute("d");
	const s2 = await page.locator("#ts-aside path.line.s2").getAttribute("d");
	expect(runCount(days, finite("wpm"))).toBeGreaterThan(1); // the demo really has gaps
	expect(mCount(s1!)).toBe(runCount(days, finite("wpm")));
	expect(mCount(s2!)).toBe(runCount(days, (r) => r.strokeWpm > 0));
	const main = await page.locator("#ts-main path.line.s1").getAttribute("d");
	expect(mCount(main!)).toBe(runCount(days, finite("wpm")));
});

test("defined() hides zeros", async ({ page }) => {
	await tsReady(page);
	const days: any[] = await page.evaluate(() => (window as any).demo.days);
	const finite = (r: any) => typeof r.strokeWpm === "number" && Number.isFinite(r.strokeWpm);
	// The zero day splits a run that plain finiteness would keep whole.
	expect(days.filter((r) => r.strokeWpm === 0)).toHaveLength(1);
	expect(runCount(days, (r) => r.strokeWpm > 0)).toBe(runCount(days, finite) + 1);
	const d = (await page.locator("#ts-aside path.line.s2").getAttribute("d"))!;
	expect(mCount(d)).toBe(runCount(days, (r) => r.strokeWpm > 0));
	// y of value 0, extrapolated from two gridlines.
	const grid = await page.locator("#ts-aside line.grid").evaluateAll((ls) => ls.map((l) => ({ v: Number(l.getAttribute("data-v")), y: Number(l.getAttribute("y1")) })));
	expect(grid.length).toBeGreaterThanOrEqual(2);
	const [a, b] = grid;
	const y0 = a.y + ((0 - a.v) * (b.y - a.y)) / (b.v - a.v);
	const ys = [...d.matchAll(/[ML][\d.-]+,([\d.-]+)/g)].map((m) => Number(m[1]));
	expect(ys.length).toBeGreaterThan(0);
	for (const y of ys) expect(Math.abs(y - y0)).toBeGreaterThan(1);
});

test("one-row chart draws a point", async ({ page }) => {
	await tsReady(page);
	await expect(page.locator("#ts-one path.line.s1")).toHaveAttribute("d", /^M[\d.]+,[\d.]+h0$/);
	await expect(page.locator("#ts-one circle.end")).toHaveCount(1);
});

test("empty data shows the empty line", async ({ page }) => {
	await tsReady(page);
	await expect(page.locator("#ts-empty .empty")).toHaveText("No data yet");
	await expect(page.locator("#ts-empty svg")).toHaveCount(0);
});

/** The day the readout rests on: the last day with any defined value. */
const restDay = (days: any[]) => [...days].reverse().find((r) => r.wpm !== null || r.strokeWpm > 0).day as string;

test("hover updates the readout, leave restores it", async ({ page }, info) => {
	test.skip(info.project.name === "phone", "hover is a mouse interaction");
	await tsReady(page);
	const days: any[] = await page.evaluate(() => (window as any).demo.days);
	const readout = page.locator("#ts-aside .readout");
	await expect(readout).toContainText(await fmtDay(page, restDay(days)));
	const rest = (await readout.textContent())!;
	const box = (await page.locator("#ts-aside .plot").boundingBox())!;
	await page.mouse.move(box.x + 2, box.y + box.height / 2);
	await expect(readout).toContainText(await fmtDay(page, days[0].day));
	await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
	await expect(readout).toContainText(await fmtDay(page, days[days.length - 1].day));
	await page.mouse.move(box.x + 2, box.y + box.height / 2);
	await expect(readout).toContainText(await fmtDay(page, days[0].day));
	await page.mouse.move(box.x + box.width / 2, box.y + box.height + 120);
	await expect(readout).toHaveText(rest);
});

test("keyboard steps and fires tk-readout", async ({ page }) => {
	await tsReady(page);
	const days: any[] = await page.evaluate(() => (window as any).demo.days);
	const n = days.length;
	await page.evaluate(() => {
		(window as any).readouts = [];
		document.addEventListener("tk-readout", (e) => (window as any).readouts.push((e as CustomEvent).detail.index));
	});
	const readouts = () => page.evaluate(() => (window as any).readouts as (number | null)[]);
	const readout = page.locator("#ts-aside .readout");
	await expect(readout).not.toBeEmpty();
	const rest = (await readout.textContent())!;
	await page.locator("#ts-aside .plot").focus();
	// End: the last slot, whatever day the rest state shows.
	await page.keyboard.press("End");
	await expect(readout).toContainText(await fmtDay(page, days[n - 1].day));
	await expect.poll(readouts).toEqual([n - 1]);
	await page.keyboard.press("ArrowLeft");
	await expect(readout).toContainText(await fmtDay(page, days[n - 2].day));
	await expect(readout).not.toContainText(await fmtDay(page, days[n - 1].day));
	await expect.poll(readouts).toEqual([n - 1, n - 2]);
	await page.keyboard.press("Escape");
	await expect.poll(readouts).toEqual([n - 1, n - 2, null]);
	await expect(readout).toHaveText(rest);
});

test("touch drag scrubs horizontally", async ({ page }, info) => {
	test.skip(info.project.name !== "phone", "touch only");
	await tsReady(page);
	const plot = page.locator("#ts-aside .plot");
	expect(await plot.evaluate((p) => getComputedStyle(p).touchAction)).toBe("pan-y");
	const readout = page.locator("#ts-aside .readout");
	const rest = await readout.textContent();
	const box = (await plot.boundingBox())!;
	const fire = (type: string, x: number) =>
		plot.evaluate((p, [type, x, y]) => {
			p.dispatchEvent(new PointerEvent(type as string, { clientX: x as number, clientY: y as number, pointerType: "touch", pointerId: 7, isPrimary: true, bubbles: true, composed: true }));
		}, [type, x, box.y + box.height / 2] as const);
	await fire("pointerdown", box.x + 2);
	await expect(readout).not.toHaveText(rest!);
	const left = await readout.textContent();
	await fire("pointermove", box.x + box.width * 0.6);
	await expect(readout).not.toHaveText(left!);
});

test("dark theme uses dark chart colors", async ({ page }) => {
	await tsReady(page, "/charts.html?theme=dark");
	expect(await page.locator("#ts-aside path.line.s1").evaluate((p) => getComputedStyle(p).stroke)).toBe("rgb(255, 170, 0)");
	expect(await page.locator("#ts-aside path.line.s2").evaluate((p) => getComputedStyle(p).stroke)).toBe("rgb(90, 166, 230)");
});

test("band washes the first band series' color", async ({ page }) => {
	await tsReady(page);
	const want = await page.evaluate(() => {
		const p = document.createElement("span");
		p.style.color = "color-mix(in srgb, var(--chart-1) 12%, transparent)";
		document.body.append(p);
		const c = getComputedStyle(p).color;
		p.remove();
		return c;
	});
	expect(await page.locator("#ts-aside path.band").evaluate((p) => getComputedStyle(p).fill)).toBe(want);
	expect(await page.locator("#ts-aside .legend .sw.wash").evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(want);
});

test("single series has no legend; two series do", async ({ page }) => {
	await tsReady(page);
	await expect(page.locator("#ts-main path.line")).toHaveCount(1);
	await expect(page.locator("#ts-main .legend")).toHaveCount(0);
	await expect(page.locator("#ts-aside .legend")).toHaveCount(1);
});

test("a fifth series warns and is not drawn", async ({ page }) => {
	await tsReady(page);
	const warnings: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "warning") warnings.push(m.text());
	});
	await page.evaluate(() => {
		const el = document.createElement("tk-timeseries") as any;
		el.id = "ts-five";
		el.series = ["a", "b", "c", "d", "e"].map((y) => ({ y, label: y }));
		el.data = [0, 1, 2].map((i) => ({ day: `2026-11-0${i + 1}`, a: 1 + i, b: 2 + i, c: 3 + i, d: 4 + i, e: 5 + i }));
		document.getElementById("main-charts")!.append(el);
	});
	await expect(page.locator("#ts-five path.line")).toHaveCount(4);
	await expect(page.locator("#ts-five path.line.s4")).toHaveCount(1);
	await expect.poll(() => warnings.filter((w) => w.includes("tk-timeseries")).length).toBeGreaterThan(0);
});

test("height falls back to 140", async ({ page }) => {
	await tsReady(page);
	const plot = page.locator("#ts-main .plot");
	const h = () => plot.evaluate((p) => p.getBoundingClientRect().height);
	await expect.poll(h).toBe(140);
	await page.locator("#ts-main").evaluate((e) => e.setAttribute("height", "90"));
	await expect.poll(h).toBe(90);
	await page.locator("#ts-main").evaluate((e) => e.removeAttribute("height"));
	await expect.poll(h).toBe(140);
	expect(await plot.getAttribute("style")).not.toContain("null");
});

// ---- tk-bars ----

const barsReady = async (page: Page, url = "/charts.html") => {
	await ready(page, url);
	await openAside(page);
	await page.waitForFunction(() => customElements.get("tk-bars"));
	await expect(page.locator("#bars-aside .row")).not.toHaveCount(0);
	await expect(page.locator("#bars-ms .row")).not.toHaveCount(0);
};

test("bars: goal tick at the same x on every row", async ({ page }) => {
	await barsReady(page);
	const xs = await page.locator("#bars-aside .tick").evaluateAll((ts) => ts.map((t) => ({ x: t.getBoundingClientRect().left, tw: t.parentElement!.getBoundingClientRect().width, tx: t.parentElement!.getBoundingClientRect().left })));
	expect(xs.length).toBeGreaterThan(3);
	for (const t of xs) {
		expect(Math.abs(t.x - xs[0].x)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(t.x - t.tx - t.tw * 0.8)).toBeLessThanOrEqual(1.5);
	}
});

test("bars: under-goal fill is --chart-2", async ({ page }) => {
	await barsReady(page);
	const keys: any[] = await page.evaluate(() => (window as any).demo.keys);
	const fills = await page.locator("#bars-aside .fill").evaluateAll((fs) => fs.map((f) => getComputedStyle(f).backgroundColor));
	expect(keys.some((k) => k.wpm < 40) && keys.some((k) => k.wpm >= 40)).toBe(true);
	keys.forEach((k, i) => expect(fills[i], k.key).toBe(k.wpm >= 40 ? "rgb(230, 149, 0)" : "rgb(0, 110, 184)"));
	// With no goal every fill is --chart-1.
	const none = await page.locator("#bars-nogoal .fill").evaluateAll((fs) => fs.map((f) => getComputedStyle(f).backgroundColor));
	expect(none.length).toBe(keys.length);
	for (const c of none) expect(c).toBe("rgb(230, 149, 0)");
});

test("lower: faster gets the longer bar", async ({ page }) => {
	await barsReady(page);
	const ms: any[] = await page.evaluate(() => (window as any).demo.ms);
	const rows = await page.locator("#bars-ms .row").evaluateAll((rs) => rs.map((r) => ({ w: r.querySelector(".fill")!.getBoundingClientRect().width, tick: r.querySelector(".tick")!.getBoundingClientRect().left - r.querySelector(".track")!.getBoundingClientRect().left })));
	const sorted = ms.map((m, i) => ({ v: m.ms, ...rows[i] })).sort((a, b) => a.v - b.v);
	for (let i = 1; i < sorted.length; i++) expect(sorted[i].w, `${sorted[i].v}ms`).toBeLessThan(sorted[i - 1].w);
	const at = sorted.find((r) => r.v === 200)!;
	expect(Math.abs(at.w - at.tick)).toBeLessThanOrEqual(1);
});

test("bars readout: rest summary, hover, keyboard", async ({ page }, info) => {
	await barsReady(page);
	const keys: any[] = await page.evaluate(() => (window as any).demo.keys);
	const readout = page.locator("#bars-aside .readout");
	const atGoal = keys.filter((k) => k.wpm >= 40).length;
	await expect(readout).toHaveText(`${atGoal} of ${keys.length} at goal`);
	await expect(page.locator("#bars-nogoal .readout")).toHaveText("");
	const h = (l: string) => page.locator(l).evaluate((e) => e.getBoundingClientRect().height);
	expect(await h("#bars-nogoal .readout")).toBeGreaterThan(10);
	const status = (k: any) => (k.wpm >= 40 ? "at goal" : "below goal");
	const want = (k: any) => `${k.key} · ${k.wpm} wpm · ${status(k)}`;
	if (info.project.name !== "phone") {
		await page.locator("#bars-aside .row").nth(2).hover();
		await expect(readout).toHaveText(want(keys[2]));
		await page.mouse.move(2, 2);
		await expect(readout).toHaveText(`${atGoal} of ${keys.length} at goal`);
	}
	await page.locator("#bars-aside .plot").focus();
	await page.keyboard.press("End");
	await expect(readout).toHaveText(want(keys[keys.length - 1]));
	await page.keyboard.press("ArrowLeft");
	await expect(readout).toHaveText(want(keys[keys.length - 2]));
	await page.keyboard.press("ArrowDown");
	await expect(readout).toHaveText(want(keys[keys.length - 2]));
});

// ---- tk-heatmap ----

const calReady = async (page: Page, url = "/charts.html") => {
	await ready(page, url);
	await openAside(page);
	await page.waitForFunction(() => customElements.get("tk-heatmap"));
	await expect(page.locator("#cal-aside .cell")).not.toHaveCount(0);
	await expect(page.locator("#cal-200 .cell")).not.toHaveCount(0);
};

const cellPos = (page: Page, sel: string, day: string) =>
	page.locator(`${sel} .cell[data-day="${day}"]`).evaluate((c) => {
		const g = getComputedStyle(c);
		return { col: parseInt(g.gridColumnStart), row: parseInt(g.gridRowStart) - 1, w: c.getBoundingClientRect().width };
	});

test("heatmap: Monday rows, last cell is end day", async ({ page }) => {
	await calReady(page);
	const last = await page.locator("#cal-aside .cell").last().getAttribute("data-day");
	expect(last).toBe("2026-11-09");
	const mon = await cellPos(page, "#cal-aside", "2026-11-09");
	const sun = await cellPos(page, "#cal-aside", "2026-11-08");
	expect(mon.row).toBe(0);
	expect(sun.row).toBe(6);
	expect(sun.col).toBe(mon.col - 1);
});

test("heatmap: narrow container drops oldest weeks, never overflows", async ({ page }) => {
	await calReady(page);
	const fits = () => page.locator("#cal-200").evaluate((e) => e.scrollWidth <= e.clientWidth);
	expect(await fits()).toBe(true);
	const w200 = (await cellPos(page, "#cal-200", "2026-11-09")).w;
	expect(w200).toBeGreaterThanOrEqual(10);
	expect(w200).toBeLessThan(18);
	const cols = () => page.locator("#cal-200").evaluate((e) => new Set([...e.shadowRoot!.querySelectorAll(".cell")].map((c) => getComputedStyle(c).gridColumnStart)).size);
	const before = await cols();
	await page.locator("#cal-narrow").evaluate((e) => { e.style.width = "100px"; });
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
	await expect.poll(cols).toBeLessThan(before);
	expect(await page.locator("#cal-200 .cell").last().getAttribute("data-day")).toBe("2026-11-09");
	expect(await fits()).toBe(true);
});

test("heatmap: zero and missing are the same empty color", async ({ page }) => {
	await calReady(page);
	const cal: any[] = (await page.evaluate(() => (window as any).demo.cal)).filter((r: any) => r.day >= "2026-08-24");
	const zero = cal.find((r) => r.value === 0)!.day;
	const gone = cal.find((r) => r.value > 40)!.day;
	const busy = cal.find((r) => r.value > 40 && r.day !== gone)!.day;
	await page.locator("#cal-aside").evaluate((e: any, [z, g]) => { e.data = e.data.filter((r: any) => r.day !== g); }, [zero, gone]);
	const panel = await resolveColor(page, "--panel");
	const fill = (d: string) => page.locator(`#cal-aside .cell[data-day="${d}"]`).evaluate((c) => getComputedStyle(c).backgroundColor);
	await expect.poll(() => fill(gone)).toBe(panel);
	expect(await fill(zero)).toBe(panel);
	expect(await fill(busy)).not.toBe(panel);
});

test("heatmap keyboard: ArrowUp moves a week", async ({ page }) => {
	await calReady(page);
	const cal: any[] = await page.evaluate(() => (window as any).demo.cal);
	const readout = page.locator("#cal-aside .readout");
	const rest = await readout.textContent();
	const vis = cal.filter((r) => r.day >= "2026-08-24");
	const total = await page.evaluate((n) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n), vis.reduce((n, r) => n + r.value, 0));
	expect(rest).toBe(`${vis.filter((r) => r.value > 0).length} days · ${total} min`);
	const want = async (d: string) => {
		const v = cal.find((r) => r.day === d)!.value;
		return `${await fmtDay(page, d)} · ${v > 0 ? `${v} min` : "none"}`;
	};
	await page.locator("#cal-aside .plot").focus();
	await page.keyboard.press("End");
	await expect(readout).toHaveText(await want("2026-11-09"));
	await expect(page.locator("#cal-aside .cell.on")).toHaveAttribute("data-day", "2026-11-09");
	await page.keyboard.press("ArrowUp");
	await expect(readout).toHaveText(await want("2026-11-02"));
	await expect(page.locator("#cal-aside .cell.on")).toHaveAttribute("data-day", "2026-11-02");
	await page.keyboard.press("ArrowLeft");
	await expect(page.locator("#cal-aside .cell.on")).toHaveAttribute("data-day", "2026-11-01");
});
