import { type Page, expect, test } from "@playwright/test";

// The seeds (hub-for-e2e.ts): e2e-search-a is a code session about restarting the hub, e2e-search-b a chat about the Pebble.
const sidebar = (page: Page) => page.locator("pi-sidebar");
const input = (page: Page) => page.locator("pi-sidebar input[type=search]");
const hits = (page: Page) => page.locator("pi-sidebar .row.hit");

// On a phone the panel is a drawer behind the header button.
async function openPanel(page: Page, isMobile: boolean) {
	await page.goto("/");
	if (isMobile) await page.getByRole("button", { name: "Open sessions" }).click();
}

async function search(page: Page, isMobile: boolean, q: string) {
	await openPanel(page, isMobile);
	await page.getByRole("button", { name: "search sessions" }).click();
	await input(page).fill(q);
}

test("search opens from the header and closes on Escape", async ({ page, isMobile }) => {
	await openPanel(page, isMobile);
	await page.getByRole("button", { name: "search sessions" }).click();
	await expect(input(page)).toBeFocused();
	await expect(page.getByRole("button", { name: "close search" })).toBeVisible();
	await input(page).press("Escape");
	await expect(input(page)).toHaveCount(0);
	await expect(page.getByRole("button", { name: "search sessions" })).toBeVisible();
});

test("typing shows title matches instantly and conversation hits after a pause", async ({ page, isMobile }) => {
	await search(page, isMobile, "restart");
	await expect(sidebar(page).getByText("In conversations")).toBeVisible();
	// The code session's hit: the snippet carries the term marked.
	const hit = hits(page).filter({ hasText: "how do we restart" });
	await expect(hit).toHaveCount(1);
	await expect(hit.locator(".snip mark").first()).toHaveText(/restart/i);
	await expect(hit).toHaveAttribute("href", /#\/s\/e2e-search-a\/at\/\d+$/);
	// A title word from another session: matched in the list at once, no hit rows needed.
	await input(page).fill("chatty");
	await expect(sidebar(page).locator("a.row", { hasText: "chatty hello" }).first()).toBeVisible();
	await input(page).clear();
	await expect(sidebar(page).getByText("In conversations")).toHaveCount(0);
});

test("toggle while searching keeps hits", async ({ page, isMobile }) => {
	// The search field takes the toggle's place in the panel, so the type is flipped around it: hits span both types either way.
	await openPanel(page, isMobile);
	const titles = sidebar(page).locator(".groups a.row:not(.hit)");
	const a = hits(page).and(page.locator('[href*="/s/e2e-search-a/"]'));
	const b = hits(page).and(page.locator('[href*="/s/e2e-search-b/"]'));
	await expect(titles.filter({ hasText: "how do we restart" })).toHaveCount(1); // code is the default list
	await page.getByRole("button", { name: "search sessions" }).click();
	await input(page).fill("restart watch");
	await expect(a).toHaveCount(1);
	await expect(b).toHaveCount(1);
	await page.getByRole("button", { name: "close search" }).click();
	await page.getByRole("button", { name: "Chat sessions" }).click();
	await expect(page.getByRole("button", { name: "Chat sessions" })).toHaveAttribute("aria-pressed", "true");
	await expect(titles.filter({ hasText: "how do we restart" })).toHaveCount(0); // the title list follows the type
	await expect(titles.filter({ hasText: "Pebble battery" })).toHaveCount(1);
	await page.getByRole("button", { name: "search sessions" }).click();
	await input(page).fill("restart watch");
	await expect(a).toHaveCount(1); // the hit list does not
	await expect(b).toHaveCount(1);
});

test("a hit opens the session scrolled to the message", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	await search(page, isMobile, "restart");
	const hit = hits(page).filter({ hasText: "how do we restart" });
	await expect(hit).toHaveCount(1);
	const n = /\/at\/(\d+)$/.exec((await hit.getAttribute("href")) ?? "")?.[1];
	expect(n).toBeTruthy();
	await hit.click();
	await expect(page).toHaveURL(/#\/s\/e2e-search-a$/); // /at/ is dropped once the jump has settled
	const target = page.locator(`pi-messages [data-ordinal="${n}"]`);
	await expect(target).toHaveClass(/jump/);
	await expect(target).toBeInViewport();
});

test("phone: hit closes the drawer and scrolls", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone flow");
	await search(page, isMobile, "restart");
	const hit = hits(page).filter({ hasText: "how do we restart" });
	await expect(hit).toHaveCount(1);
	const n = /\/at\/(\d+)$/.exec((await hit.getAttribute("href")) ?? "")?.[1];
	await hit.click();
	await expect(page.locator("pi-app .layout")).not.toHaveClass(/nav-open/);
	await expect(page).toHaveURL(/#\/s\/e2e-search-a$/);
	const target = page.locator(`pi-messages [data-ordinal="${n}"]`);
	await expect(target).toHaveClass(/jump/);
	await expect(target).toBeInViewport();
});

test("an old hub degrades quietly", async ({ page, isMobile }) => {
	const errors: string[] = [];
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	await page.route(/\/api\/search/, (r) => r.fulfill({ status: 404, json: { error: "search is not available" } }));
	await search(page, isMobile, "restart");
	await expect(sidebar(page).getByText("Search isn't available on this hub.")).toBeVisible();
	expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]); // the browser logs the stubbed 404 itself; nothing of the app's own
});
