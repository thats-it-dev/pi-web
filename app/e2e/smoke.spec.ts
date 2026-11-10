import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { startTerminalPi } from "../../hub/test/support/terminal-pi.ts";

const WORKDIR = join(tmpdir(), "pi-web-e2e-work"); // keep in sync with hub-for-e2e.ts

// A new chat runs nothing on the hub until its first message: pick the folder, then send.
async function startChat(page: Page, text: string, folder = WORKDIR) {
	await page.goto("/#/new");
	await pickFolder(page, folder);
	await page.getByLabel("Message").fill(text);
	await page.getByRole("button", { name: "send" }).click(); // the on-screen keyboard's Return makes a new line
	await expect(page).toHaveURL(/#\/s\//);
}

async function pickFolder(page: Page, folder: string) {
	await expect(page.getByRole("button", { name: /^Model Fake/ })).toBeVisible(); // the menu's rows move when the models arrive
	await page.getByRole("button", { name: "Chat options" }).click();
	await page.getByRole("button", { name: /^folder/ }).click();
	await page.getByLabel("Folder path").fill(folder);
	await page.getByLabel("Folder path").press("Enter");
	await expect(page.getByRole("button", { name: /^folder/ })).toContainText(folder);
	await page.keyboard.press("Escape");
}

async function pickDraftModel(page: Page, name: string) {
	await expect(page.getByRole("button", { name: /^Model Fake/ })).toBeVisible();
	await page.getByRole("button", { name: "Chat options" }).click();
	await page.getByRole("button", { name: /^model/ }).click();
	await page.getByRole("option", { name: new RegExp(name) }).click();
	await expect(page.getByRole("button", { name: /^model/ })).toContainText(name);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: new RegExp(`^Model ${name}`) })).toBeVisible();
}

const noSessions = (page: Page) =>
	page.route(/\/api\/sessions$/, (route) => (route.request().method() === "GET" ? route.fulfill({ json: { sessions: [], home: "/home/e2e" } }) : route.fallback()));

test("launch with no route opens a new chat when nothing is recent", async ({ page }) => {
	await noSessions(page);
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "new chat" })).toBeVisible();
	await expect(page).toHaveURL(/#\/new$/);
});

test("new chat: send creates the session in ~ and the reply streams", async ({ page }) => {
	await page.goto("/#/new");
	await expect(page.locator("pi-composer .folder")).toContainText("~");
	await page.getByLabel("Message").fill("hi");
	await page.getByRole("button", { name: "send" }).click();
	await expect(page).toHaveURL(/#\/s\//);
	await expect(page.locator("pi-messages .user")).toContainText("hi");
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await page.getByRole("button", { name: "Session stats" }).click();
	await expect(page.locator('dl.stats dt:has-text("folder") + dd')).toHaveText("~");
});

test("new chat: a bad folder keeps the message and says why", async ({ page }) => {
	await page.goto("/#/new");
	await pickFolder(page, "/nope");
	await page.getByLabel("Message").fill("hi");
	await page.getByRole("button", { name: "send" }).click();
	await expect(page.locator("tk-toasts")).toContainText("Not a folder");
	await expect(page.getByLabel("Message")).toHaveValue("hi");
	await expect(page).toHaveURL(/#\/new$/);
});

test("new chat: the model picked in the draft is the one pi starts with, and the next new chat remembers it", async ({ page }) => {
	// Both ways round, so the hub is left on Fake A (pi's default) for the tests after this one.
	await page.goto("/#/new");
	for (const name of ["Fake B", "Fake A"]) {
		await pickDraftModel(page, name);
		await page.getByLabel("Message").fill("hi");
		await page.getByRole("button", { name: "send" }).click();
		await expect(page).toHaveURL(/#\/s\//);
		await expect(page.locator("pi-messages")).toContainText("Hello world");
		await expect(page.getByRole("button", { name: new RegExp(`^Model ${name}`) })).toBeVisible();
		await page.locator("pi-header").getByRole("button", { name: "New chat" }).click();
		await expect(page).toHaveURL(/#\/new$/);
		await expect(page.getByRole("button", { name: new RegExp(`^Model ${name}`) })).toBeVisible();
	}
});

test("new chat: the approvals picked in the draft are the running session's", async ({ page }) => {
	await page.goto("/#/new");
	await expect(page.getByRole("button", { name: /^Model Fake/ })).toBeVisible();
	await page.getByRole("button", { name: "Chat options" }).click();
	await expect(page.getByRole("button", { name: /^approvals/ })).toContainText("auto"); // the hub's default
	await page.getByRole("button", { name: /^approvals/ }).click();
	await page.getByRole("radio", { name: "manual" }).click();
	await page.getByRole("button", { name: "‹ approvals" }).click();
	await expect(page.getByRole("button", { name: /^approvals/ })).toContainText("manual");
	await page.keyboard.press("Escape");
	await page.getByLabel("Message").fill("hi");
	await page.getByRole("button", { name: "send" }).click();
	await expect(page).toHaveURL(/#\/s\//);
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await page.getByRole("button", { name: "Chat options" }).click();
	await expect(page.getByRole("button", { name: /^approvals/ })).toContainText("manual");
});

test("new chat: when the models can't load, the menu says so instead of loading forever", async ({ page }) => {
	await page.route(/\/api\/defaults$/, (route) => route.fulfill({ status: 500, json: { error: "probe failed" } }));
	await page.goto("/#/new");
	await expect(page.locator("tk-toasts")).toContainText("Couldn't load the models");
	await page.getByRole("button", { name: "Chat options" }).click();
	await page.getByRole("button", { name: /^model/ }).click();
	await expect(page.locator("tk-sheet")).toContainText("couldn't load models");
	await page.getByRole("button", { name: "‹ model" }).click();
	await page.getByRole("button", { name: /^approvals/ }).click();
	await expect(page.locator("tk-sheet")).toContainText("couldn't load");
});

test("launch reopens a session active within 2 hours", async ({ page }) => {
	await startChat(page, "hi");
	const url = page.url();
	await page.goto("/");
	await expect(page).toHaveURL(url);
	await expect(page.locator("pi-messages")).toContainText("Hello world");
});

test("desktop: start a session, stream a reply, switch model, rename and compact with slash commands", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	await startChat(page, "hi");
	const input = page.getByLabel("Message");
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await expect(page.getByRole("button", { name: "Session stats" })).toContainText("/ 1k"); // fake-a has a 1000-token window

	await page.getByRole("button", { name: /^Model Fake A/ }).click();
	await page.getByRole("option", { name: /Fake B/ }).click();
	await expect(page.getByRole("button", { name: /^Model Fake B/ })).toBeVisible();

	await page.getByRole("button", { name: "Chat options" }).click();
	await page.getByRole("button", { name: /^approvals/ }).click();
	await page.getByRole("radio", { name: "semi" }).click();
	await page.getByRole("button", { name: "‹ approvals" }).click();
	await expect(page.getByRole("button", { name: /^approvals/ })).toContainText("semi");
	await page.keyboard.press("Escape");

	await input.fill("/na");
	await expect(page.getByRole("listbox", { name: "Commands" })).toContainText("/name");
	await input.press("Enter");
	await expect(input).toHaveValue("/name ");
	await input.pressSequentially("e2e run");
	await input.press("Enter");
	await expect(page.locator("pi-header h1")).toHaveText("e2e run");
	await expect(page.locator("pi-sidebar")).toContainText("e2e run");

	await input.fill("again");
	await input.press("Enter");
	await expect(page.locator("pi-messages").getByText("Hello world")).toHaveCount(2);
	await input.fill("/compact ");
	await input.press("Enter");
	await expect(page.locator("pi-messages details.marker")).toContainText("compacted");
	await expect(page.locator("pi-messages .user").first()).not.toHaveText("hi"); // the first turn was summarized away
});

test("desktop: @ mentions complete files and folders from the session's folder", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	await startChat(page, "hi"); // @ completes against a running session's folder
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	const input = page.getByLabel("Message");
	await input.pressSequentially("look at @do");
	const files = page.getByRole("listbox", { name: "Files" });
	await expect(files).toContainText("docs/");
	await input.press("Enter");
	await expect(input).toHaveValue("look at @docs/");
	await expect(files.getByRole("option").first()).toHaveText("docs/notes.md");
	await input.press("Enter");
	await expect(input).toHaveValue("look at @docs/notes.md ");
	await expect(files).toHaveCount(0);
});

test("the agent's show_image appears and opens full screen", async ({ page }) => {
	await startChat(page, "show me the test card");
	const figure = page.locator("pi-messages figure.shot");
	await expect(figure).toHaveCount(1);
	await figure.scrollIntoViewIfNeeded();
	await expect(figure).toContainText("A red and blue test card");
	await expect(figure).toContainText("show_image · shot.png");
	const img = figure.locator("pi-image img.pic");
	await expect(img).toBeVisible();
	await expect(img).toHaveAttribute("src", /^blob:/);
	// The 16 px test card is scaled up to the column width, not shown at its natural size.
	const shot = await img.boundingBox();
	const column = await figure.boundingBox();
	expect(shot!.width).toBeGreaterThan(column!.width * 0.9);
	await figure.locator("pi-image button.pic").click();
	const viewer = figure.locator("pi-image button.viewer");
	await expect(viewer).toBeVisible();
	await viewer.click();
	await expect(viewer).toHaveCount(0);
});

test("phone: send with the button, then find the session from the menu", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone flow");
	await startChat(page, "hello from the phone");
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await page.locator("pi-header").getByRole("button", { name: "Open sessions" }).click();
	await expect(page.locator("pi-sidebar")).toContainText("hello from the phone");
	const layout = page.locator("pi-app .layout");
	await expect(layout).toHaveClass(/nav-open/);
	await page.locator("pi-sidebar a.row.cur").click(); // the session already open: no hash change
	await expect(layout).not.toHaveClass(/nav-open/);
});

const E2E_ENV_FILE = join(tmpdir(), "pi-web-e2e-env.json"); // written by hub-for-e2e.ts

test("terminal: a pi open in a terminal is live in the app, and prompts from either side show in both", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	const e2e = JSON.parse(readFileSync(E2E_ENV_FILE, "utf8")) as { piBin: string; agentDir: string; socketPath: string };
	const term = startTerminalPi({ piBin: e2e.piBin, cwd: WORKDIR, env: { PI_CODING_AGENT_DIR: e2e.agentDir }, socketPath: e2e.socketPath });
	try {
		const id = (await term.call({ type: "get_state" })).data.sessionId as string;
		await page.goto(`/#/s/${id}`);
		await expect(page.locator("pi-header")).toContainText("open in terminal");

		const input = page.getByLabel("Message");
		await input.fill("from the app");
		await input.press("Enter");
		await expect(page.locator("pi-messages")).toContainText("Hello world");
		await term.records.waitFor((r) => r.type === "message_end" && r.message?.role === "user" && JSON.stringify(r.message.content).includes("from the app"));

		term.send({ type: "prompt", message: "from the terminal" });
		await expect(page.locator("pi-messages")).toContainText("from the terminal");
		await expect(page.locator("pi-messages").getByText("Hello world")).toHaveCount(2);

		await input.fill("/as");
		await expect(page.getByRole("listbox", { name: "Commands" }).locator(".opt.off")).toContainText("/ask");
		await input.fill("");

		await term.quit();
		await expect(page.getByLabel("Message")).toHaveAttribute("placeholder", "continue here");
	} finally {
		await term.quit();
	}
});

// Seeded by hub-for-e2e.ts from the progress fixtures.
const TODO_SESSION = "01a1bd36-16ac-7413-9382-8ac913737489"; // three to-dos, all done
const SUBAGENT_SESSION = "01a1bd37-0fea-71de-9b21-5898d150477c"; // one foreground subagent, done
const PLAN_SESSION = "e2e-plan-session";

test("desktop: the progress column shows to-dos and subagents beside the chat", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	await page.goto(`/#/s/${TODO_SESSION}`);
	const aside = page.locator("tk-shell [slot=aside]");
	await expect(aside).toContainText("to-dos");
	await expect(aside).toContainText("3/3");
	await expect(aside.locator("section.run")).toContainText("tool calls");
	await expect(aside.locator("section.run")).toContainText(/reviewer\s*not yet/);
	const button = page.getByRole("button", { name: "Progress" });
	await expect(button).toHaveAttribute("aria-expanded", "true");
	await button.click();
	await expect(button).toHaveAttribute("aria-expanded", "false");
	await expect(aside).toBeHidden(); // a collapsed column is zero wide
	await button.click();
	await expect(button).toHaveAttribute("aria-expanded", "true");
	await expect(aside).toBeVisible();

	await page.goto(`/#/s/${SUBAGENT_SESSION}`);
	await expect(aside).toContainText("subagents");
	await expect(aside.locator(".child")).toHaveCount(1);
	await expect(aside.locator(".child [aria-label=done]")).toHaveCount(1);
});

test("desktop: a plan opens in a sheet", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	await page.goto(`/#/s/${PLAN_SESSION}`);
	const aside = page.locator("tk-shell [slot=aside]");
	await expect(aside).toContainText("Task 1: First");
	await aside.getByRole("button", { name: "open plan" }).click();
	await expect(page.locator("tk-sheet")).toContainText("Plan P");
});

test("desktop: a session with no progress has no column", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	await startChat(page, "plain");
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await expect(page.getByRole("button", { name: "Progress" })).toHaveCount(0);
	await expect(page.locator("tk-shell [slot=aside]")).toHaveCount(0);
});

test("mid width: progress is a drawer beside the docked session list", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	await page.setViewportSize({ width: 1000, height: 800 });
	await page.goto(`/#/s/${TODO_SESSION}`);
	await expect(page.locator("pi-sidebar")).toBeVisible();
	await expect(page.locator("pi-sidebar")).toBeInViewport();
	const panel = page.locator("tk-shell [slot=aside]");
	await expect(panel).toContainText("to-dos");
	await expect(panel).not.toBeInViewport();
	const button = page.getByRole("button", { name: "Progress" });
	await expect(button).toHaveAttribute("aria-expanded", "false");
	await button.click();
	await expect(panel).toBeInViewport();
	await expect(button).toHaveAttribute("aria-expanded", "true");
	await page.goBack();
	await expect(panel).not.toBeInViewport();
	await expect(page).toHaveURL(new RegExp(`#/s/${TODO_SESSION}$`));
});

test("phone: a badge opens the progress drawer; Escape, the dimmed area and Back close it", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone flow");
	await page.goto(`/#/s/${TODO_SESSION}`);
	const drawer = page.locator("tk-shell [slot=aside]");
	await expect(drawer).toContainText("to-dos");
	await expect(drawer).not.toBeInViewport();
	const badge = page.getByRole("button", { name: "Progress" });
	await expect(badge).toHaveText("3/3");
	await badge.click();
	await expect(drawer).toBeInViewport();
	await page.keyboard.press("Escape");
	await expect(drawer).not.toBeInViewport();
	await expect(page).toHaveURL(new RegExp(`#/s/${TODO_SESSION}$`));

	await badge.click();
	await expect(drawer).toBeInViewport();
	await page.locator("tk-shell .overlay").click({ position: { x: 10, y: 300 } });
	await expect(drawer).not.toBeInViewport();
	await expect(page).toHaveURL(new RegExp(`#/s/${TODO_SESSION}$`));

	await badge.click();
	await expect(drawer).toBeInViewport();
	await page.goBack();
	await expect(drawer).not.toBeInViewport();
	await expect(page).toHaveURL(new RegExp(`#/s/${TODO_SESSION}$`));
});

test("phone: scrolling down tucks the header away completely, scrolling up brings it back", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone flow");
	await page.goto(`/#/s/${TODO_SESSION}`);
	const header = page.locator("pi-session tk-header");
	await expect(header).toBeInViewport();
	await page.locator("pi-messages").evaluate((el) => ((el as HTMLElement).style.minHeight = "4000px")); // room to scroll
	const scroller = page.locator("pi-session .scroll");
	await scroller.evaluate((el) => el.scrollBy(0, 300));
	await expect(header).not.toBeInViewport();
	// No band left where the header was: the chat itself reaches the top of the screen.
	expect(await scroller.evaluate((el) => el.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
	await scroller.evaluate((el) => el.scrollBy(0, -10));
	await expect(header).toBeInViewport();
});

test("phone: finished subagents still get a badge", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone flow");
	await page.goto(`/#/s/${SUBAGENT_SESSION}`);
	await expect(page.getByRole("button", { name: "Progress" })).toHaveText("•");
});

test("phone: the plan sheet opens above the progress drawer", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone flow");
	await page.goto(`/#/s/${PLAN_SESSION}`);
	await page.getByRole("button", { name: "Progress" }).click();
	const drawer = page.locator("tk-shell [slot=aside]");
	await expect(drawer).toBeInViewport();
	await drawer.getByRole("button", { name: "open plan" }).click();
	const sheet = page.locator("tk-sheet");
	await expect(sheet).toContainText("Plan P");
	await sheet.getByRole("button", { name: "Close" }).click(); // clickable, so nothing covers it
	await expect(sheet).toHaveCount(0);
	await expect(drawer).toBeInViewport(); // closing the sheet left the drawer open
});

test("desktop: a subagent row opens its transcript read-only, back to parent returns", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	await page.goto(`/#/s/${SUBAGENT_SESSION}`);
	const aside = page.locator("tk-shell [slot=aside]");
	await aside.locator(".child").click();
	const thread = page.locator("pi-child-thread");
	await expect(thread).toContainText("scout");
	await expect(thread.getByText("read-only", { exact: true })).toBeVisible();
	await expect(thread).toContainText("Child task: list the files here");
	await expect(page.locator("pi-child-thread textarea, pi-child-thread input")).toHaveCount(0);
	await expect(page.locator("pi-composer textarea")).toBeHidden();
	await expect(aside.locator(".child")).toHaveAttribute("aria-current", "true"); // the column stays live and marks it
	await expect(thread.getByRole("button", { name: "Progress, •", exact: true })).toBeVisible(); // the thread's header keeps the badge
	await expect(page.locator("pi-composer textarea")).toBeHidden();
	await thread.getByRole("button", { name: "back to parent" }).click();
	await expect(thread).toHaveCount(0);
	await expect(page.locator("pi-composer")).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`#/s/${SUBAGENT_SESSION}$`));
});

test("desktop: an unsent draft survives a trip to a subagent thread", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	await page.goto(`/#/s/${SUBAGENT_SESSION}`);
	await page.getByLabel("Message").fill("half-written thought");
	await page.locator("tk-shell [slot=aside] .child").click();
	await expect(page.locator("pi-child-thread")).toContainText("Child task");
	await page.locator("pi-child-thread").getByRole("button", { name: "back to parent" }).click();
	await expect(page.getByLabel("Message")).toHaveValue("half-written thought");
});

test("phone: badge, row, thread full screen, back returns to the parent chat", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone flow");
	await page.goto(`/#/s/${SUBAGENT_SESSION}`);
	await page.getByRole("button", { name: "Progress" }).click();
	const drawer = page.locator("tk-shell [slot=aside]");
	await expect(drawer).toBeInViewport();
	await drawer.locator(".child").click();
	const thread = page.locator("pi-child-thread");
	await expect(thread).toContainText("Child task: list the files here");
	await expect(drawer).not.toBeInViewport();
	await expect(page.locator("pi-child-thread textarea, pi-child-thread input")).toHaveCount(0);
	await expect(thread.getByRole("button", { name: /^Progress/ })).toHaveText("•");
	await expect(page.locator("pi-composer textarea")).toBeHidden();
	await page.goBack(); // the drawer's entry was replaced: this lands on the parent chat
	await expect(thread).toHaveCount(0);
	await expect(page.locator("pi-composer")).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`#/s/${SUBAGENT_SESSION}$`));
});
