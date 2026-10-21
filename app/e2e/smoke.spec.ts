import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startTerminalPi } from "../../hub/test/support/terminal-pi.ts";

const WORKDIR = join(tmpdir(), "pi-web-e2e-work"); // keep in sync with hub-for-e2e.ts

async function startSession(page: import("@playwright/test").Page) {
	await page.goto("/#/new");
	await page.getByLabel("Folder path").fill(WORKDIR);
	await page.getByRole("button", { name: "start session" }).click();
	await expect(page).toHaveURL(/#\/s\//);
}

test("desktop: start a session, stream a reply, switch model, rename and compact with slash commands", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop flow");
	await startSession(page);
	const input = page.getByLabel("Message");
	await input.fill("hi");
	await input.press("Enter");
	await expect(page.locator("pi-messages")).toContainText("Hello world");
	await expect(page.getByRole("button", { name: "Session stats" })).toContainText("/ 1k"); // fake-a has a 1000-token window

	await page.getByRole("button", { name: /^Model Fake A/ }).click();
	await page.getByRole("option", { name: /Fake B/ }).click();
	await expect(page.getByRole("button", { name: /^Model Fake B/ })).toBeVisible();

	await page.getByRole("button", { name: /^Session settings/ }).click();
	await page.getByRole("radio", { name: "semi" }).click();
	await expect(page.getByRole("button", { name: "Session settings (semi)" })).toBeVisible();
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
	await startSession(page);
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
	await startSession(page);
	const input = page.getByLabel("Message");
	await input.fill("show me the test card");
	await page.getByRole("button", { name: "send" }).click();
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
	await startSession(page);
	await page.getByLabel("Message").fill("hello from the phone");
	await page.getByRole("button", { name: "send" }).click();
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
