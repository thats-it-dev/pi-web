import { type Page, expect, test } from "@playwright/test";

const codeTitle = (page: Page) => page.locator("pi-sidebar .row .t");
const toggle = (page: Page, name: "Code sessions" | "Chat sessions") => page.locator("pi-sidebar").getByRole("button", { name });
const newButton = (page: Page) => page.locator("pi-sidebar .new-session");

// A phone keeps the session list in a drawer.
async function openPanel(page: Page, isMobile: boolean) {
	if (isMobile) await page.getByRole("button", { name: "Open sessions" }).click();
	await expect(page.locator("pi-sidebar")).toBeVisible();
}

async function menuRow(page: Page, role: "button" | "switch", name: RegExp) {
	await expect(page.getByRole("button", { name: /^Model Fake/ })).toBeVisible(); // the menu's rows move when the models arrive
	await page.getByRole("button", { name: "Chat options" }).click();
	return page.getByRole(role, { name });
}

const apiSessions = async (page: Page) => (await (await page.request.get("/api/sessions")).json()) as { sessions: { id: string; type: string; cwd: string }[]; home: string };

test("the toggle filters the list and the button label follows", async ({ page, isMobile }) => {
	await page.goto("/#/new");
	await openPanel(page, isMobile);
	await expect(toggle(page, "Code sessions")).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator("pi-sidebar").getByRole("group", { name: "Session type" })).toBeVisible();
	await expect(codeTitle(page).filter({ hasText: "show me the app" }).first()).toBeVisible();
	await expect(codeTitle(page).filter({ hasText: "chatty hello" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^new (code session|chat)$/ })).toHaveText(/new code session/);

	await toggle(page, "Chat sessions").click();
	await expect(toggle(page, "Chat sessions")).toHaveAttribute("aria-pressed", "true");
	await expect(codeTitle(page).filter({ hasText: "chatty hello" })).toBeVisible();
	await expect(codeTitle(page).filter({ hasText: "show me the app" })).toHaveCount(0);
	await expect(newButton(page)).toHaveText(/new chat/);
	await expect(page.getByRole("button", { name: /^new (code session|chat)$/ })).toBeVisible();
});

test("the open session stays when the toggle flips", async ({ page, isMobile }) => {
	await page.goto("/#/s/e2e-chat");
	await openPanel(page, isMobile);
	const url = page.url();
	await toggle(page, "Chat sessions").click();
	await expect(toggle(page, "Chat sessions")).toHaveAttribute("aria-pressed", "true");
	await toggle(page, "Code sessions").click();
	await expect(toggle(page, "Code sessions")).toHaveAttribute("aria-pressed", "true");
	await expect(codeTitle(page).filter({ hasText: "show me the app" }).first()).toBeVisible();
	await expect(page).toHaveURL(url);
});

test("a new chat lands in home with no folder row", async ({ page, isMobile }) => {
	await page.goto("/#/new");
	await openPanel(page, isMobile);
	await toggle(page, "Chat sessions").click();
	await newButton(page).click();
	await expect(page.getByRole("heading", { name: "new chat" })).toBeVisible();
	await expect(await menuRow(page, "button", /^folder/)).toHaveCount(0);
	await expect(page.getByRole("switch", { name: /^superpowers/ })).toHaveAttribute("aria-checked", "false");
	await page.keyboard.press("Escape");
	await page.getByLabel("Message").fill("hi");
	await page.getByRole("button", { name: "send" }).click();
	await expect(page).toHaveURL(/#\/s\//);
	const id = page.url().split("/s/")[1];
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await expect(await menuRow(page, "button", /^folder/)).toHaveCount(0);
	await expect
		.poll(async () => {
			const { sessions, home } = await apiSessions(page);
			const s = sessions.find((x) => x.id === id);
			return s ? { type: s.type, inHome: s.cwd === home, notWork: !s.cwd.endsWith("pi-web-e2e-work") } : null;
		})
		.toEqual({ type: "chat", inHome: true, notWork: true });
});

test("a new code session starts with superpowers on", async ({ page, isMobile }) => {
	await page.goto("/#/new");
	await openPanel(page, isMobile);
	await toggle(page, "Code sessions").click();
	await newButton(page).click();
	await expect(page.getByRole("heading", { name: "new code session" })).toBeVisible();
	await expect(await menuRow(page, "switch", /^superpowers/)).toHaveAttribute("aria-checked", "true");
	await expect(page.getByRole("button", { name: /^folder/ })).toBeVisible();
});

test("a chat draft's superpowers-on reaches the live session", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("pi-web:session-type", "chat")); // the toggle on chat
	await page.goto("/#/new");
	await expect(page.getByRole("heading", { name: "new chat" })).toBeVisible();
	const sp = await menuRow(page, "switch", /^superpowers/);
	await expect(sp).toHaveAttribute("aria-checked", "false");
	await sp.click();
	await expect(sp).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Escape");
	await page.getByLabel("Message").fill("hi");
	await page.getByRole("button", { name: "send" }).click();
	await expect(page).toHaveURL(/#\/s\//);
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await expect(await menuRow(page, "switch", /^superpowers/)).toHaveAttribute("aria-checked", "true");
});

test("a stored chat type launches into a new chat, not a recent code session", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("pi-web:session-type", "chat"));
	// The hub's real list without its chats, the seeded code session made recent: only the type keeps it from opening.
	await page.route(/\/api\/sessions$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		const res = await route.fetch();
		const body = (await res.json()) as { sessions: { id: string; type: string; updatedAt: number; live: boolean }[]; home: string };
		const sessions = body.sessions.filter((s) => s.type === "code").map((s) => ({ ...s, live: false }));
		const recent = sessions[0];
		if (!recent) throw new Error("no seeded code session");
		recent.updatedAt = Date.now();
		await route.fulfill({ response: res, json: { ...body, sessions } });
	});
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "new chat" })).toBeVisible();
	await expect(page).toHaveURL(/#\/new$/);
});

test("the setting survives a reload", async ({ page, isMobile }) => {
	await page.goto("/#/new");
	await openPanel(page, isMobile);
	await toggle(page, "Chat sessions").click();
	await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-web:session-type"))).toBe("chat");
	await page.reload();
	await openPanel(page, isMobile);
	await expect(toggle(page, "Chat sessions")).toHaveAttribute("aria-pressed", "true");
	await expect(newButton(page)).toHaveText(/new chat/);
});

test("flipping the toggle keeps the typed draft", async ({ page, isMobile }) => {
	await page.goto("/#/new");
	await expect(page.getByRole("button", { name: /^Model Fake/ })).toBeVisible();
	await page.getByLabel("Message").fill("half a thought");
	await openPanel(page, isMobile);
	await toggle(page, "Chat sessions").click();
	await expect(page.getByRole("heading", { name: "new chat" })).toBeVisible();
	await expect(page.getByLabel("Message")).toHaveValue("half a thought");
});

test("phone: the button never covers the last row", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone only");
	await page.goto("/#/new");
	await openPanel(page, isMobile);
	const rows = page.locator("pi-sidebar .row");
	await expect(rows.last()).toBeAttached();
	await rows.last().scrollIntoViewIfNeeded();
	await page.locator("pi-sidebar .groups").evaluate((el) => (el.scrollTop = el.scrollHeight));
	await expect
		.poll(async () => {
			const row = await rows.last().boundingBox();
			const btn = await newButton(page).boundingBox();
			return row && btn ? row.y + row.height <= btn.y : false;
		})
		.toBe(true);
});

test("phone: tapping new while already on a new chat closes the drawer", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone only");
	await page.goto("/#/new");
	const menu = page.locator("pi-header").getByRole("button", { name: "Open sessions" });
	await menu.click();
	await expect(menu).toHaveAttribute("aria-expanded", "true");
	await newButton(page).click();
	await expect(menu).toHaveAttribute("aria-expanded", "false");
	await expect(page).toHaveURL(/#\/new$/);
});
