import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A picture of an app's screen as a phone shows it, taken from the app's own working tree with the app's own
// Vite and Playwright. `npm run verify` proves the code runs; this is the only step that shows what it draws.

export type Scheme = "dark" | "light";
/** `click`: a CSS selector (open shadow roots are pierced) clicked once the app rendered, so a dialog, menu or tab the
 *  change lives in is what the picture shows. `upload`: a file set on the app's file input (`into`, default
 *  `input[type=file]`) after the click, so the picture shows the app with Michael's data loaded; any dialog left open
 *  is closed first, since the file input usually lives in one and the result is what matters. */
export type ScreenshotOpts = { path?: string; scheme?: Scheme; click?: string; upload?: string; into?: string };
export const DEFAULT_FILE_INPUT = "input[type=file]";
export type Screenshot = { file: string; width: number; height: number; issues: string[] };

export const VIEWPORT = { width: 390, height: 844 };
export const SCALE = 2;
/** Taller pages are cut here: a longer picture costs the model more than it shows. */
export const MAX_HEIGHT = 2400;
export const RENDER_TIMEOUT_MS = 30_000;
export const CLICK_TIMEOUT_MS = 10_000;
/** After the click: what it opened has rendered (reduced motion, so no transition to wait out). */
export const SETTLE_MS = 300;

/** Where the picture goes: test-results is ignored by git, so it never lands in a commit or a review diff. */
export function screenFile(dir: string, scheme: Scheme, path = "/", click?: string, upload?: string): string {
	const slug = (s: string) => s.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
	const route = slug(path);
	const opened = click ? slug(click).slice(0, 40) : "";
	const loaded = upload ? slug(basename(upload)).slice(0, 40) : "";
	return join(dir, "test-results", "screens", `phone-${scheme}${route ? `-${route}` : ""}${opened ? `-click-${opened}` : ""}${loaded ? `-with-${loaded}` : ""}.png`);
}

/** Normalises the --path value: a route starting with "/", or the root. */
export function routeOf(path: string | undefined): string {
	if (!path || path === "/") return "/";
	return path.startsWith("/") ? path : `/${path}`;
}

type Deps = {
	createServer: (config: Record<string, unknown>) => Promise<{ listen(): Promise<unknown>; close(): Promise<unknown>; resolvedUrls?: { local: string[] } | null }>;
	chromium: {
		launch(): Promise<{
			newContext(o: Record<string, unknown>): Promise<{
				newPage(): Promise<Page>;
				close(): Promise<void>;
			}>;
			close(): Promise<void>;
		}>;
	};
};

type Page = {
	on(event: string, cb: (arg: any) => void): void;
	goto(url: string, o?: Record<string, unknown>): Promise<unknown>;
	click(selector: string, o?: Record<string, unknown>): Promise<unknown>;
	setInputFiles(selector: string, files: string, o?: Record<string, unknown>): Promise<unknown>;
	waitForTimeout(ms: number): Promise<void>;
	waitForFunction(fn: string, arg?: unknown, o?: Record<string, unknown>): Promise<unknown>;
	waitForLoadState(state: string, o?: Record<string, unknown>): Promise<void>;
	evaluate<T>(fn: string): Promise<T>;
	screenshot(o: Record<string, unknown>): Promise<Buffer>;
};

/** The app's own vite and playwright, so the picture comes from the versions the app builds and tests with. */
export async function appDeps(dir: string): Promise<Deps> {
	const require = createRequire(join(dir, "package.json"));
	const load = async (name: string) => {
		let resolved: string;
		try {
			resolved = require.resolve(name);
		} catch {
			throw new Error(`${dir} has no ${name} in node_modules; run npm ci in the app first`);
		}
		return import(pathToFileURL(resolved).href);
	};
	const vite = await load("vite");
	// playwright is CommonJS: its exports sit on `default` when imported from ESM.
	const playwright = await load("playwright");
	return { createServer: vite.createServer, chromium: playwright.chromium ?? playwright.default.chromium };
}

// Evaluated in the page as expressions (source text carries no transpiler helpers).
const RENDERED = "(document.querySelector('app-main')?.shadowRoot?.childElementCount ?? 0) > 0";
const PAGE_HEIGHT = "Math.ceil(document.documentElement.scrollHeight)";
// Closes every open <dialog>, through open shadow roots, and says how many it closed.
const CLOSE_DIALOGS = "(() => { let n = 0; const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'DIALOG' && el.open) { el.close(); n += 1; } if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return n; })()";

export async function screenshotApp(dir: string, opts: ScreenshotOpts = {}, deps?: Deps): Promise<Screenshot> {
	const d = deps ?? (await appDeps(dir));
	const scheme: Scheme = opts.scheme ?? "dark";
	const route = routeOf(opts.path);
	const file = screenFile(dir, scheme, route, opts.click, opts.upload);
	mkdirSync(join(dir, "test-results", "screens"), { recursive: true });
	const issues: string[] = [];
	// The dev server serves the working tree as it is, uncommitted edits included, with no build step.
	const server = await d.createServer({ root: dir, configFile: join(dir, "vite.config.ts"), logLevel: "silent", clearScreen: false, server: { host: "127.0.0.1", strictPort: false } });
	let browser: Awaited<ReturnType<Deps["chromium"]["launch"]>> | undefined;
	try {
		await server.listen();
		const base = server.resolvedUrls?.local[0];
		if (!base) throw new Error("vite dev server reported no local URL");
		browser = await d.chromium.launch();
		const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, isMobile: true, hasTouch: true, colorScheme: scheme, reducedMotion: "reduce" });
		const page = await ctx.newPage();
		page.on("console", (m) => {
			if (m.type() === "error" || m.type() === "warning") issues.push(`console ${m.type()}: ${m.text()}`);
		});
		page.on("pageerror", (e) => issues.push(`page error: ${e.message}`));
		page.on("requestfailed", (r) => issues.push(`request failed: ${r.url()} (${r.failure()?.errorText ?? "?"})`));
		await page.goto(`${base.replace(/\/$/, "")}${route}`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
		try {
			await page.waitForFunction(RENDERED, undefined, { timeout: RENDER_TIMEOUT_MS });
		} catch {
			issues.push("app-main rendered nothing within 30 s; the picture shows the page as it was");
		}
		if (opts.click) {
			try {
				await page.click(opts.click, { timeout: CLICK_TIMEOUT_MS });
				await page.waitForTimeout(SETTLE_MS);
			} catch (err) {
				issues.push(`--click ${opts.click}: ${(err as Error).message.split("\n")[0]}; the picture shows the screen without the click`);
			}
		}
		if (opts.upload) {
			const into = opts.into ?? DEFAULT_FILE_INPUT;
			try {
				await page.setInputFiles(into, resolve(opts.upload), { timeout: CLICK_TIMEOUT_MS });
				await page.waitForTimeout(SETTLE_MS);
				if ((await page.evaluate<number>(CLOSE_DIALOGS)) > 0) await page.waitForTimeout(SETTLE_MS);
			} catch (err) {
				issues.push(`--upload ${opts.upload} into ${into}: ${(err as Error).message.split("\n")[0]}; the picture shows the app without the file`);
			}
		}
		await page.evaluate("document.fonts.ready");
		await page.waitForLoadState("networkidle", { timeout: RENDER_TIMEOUT_MS }).catch(() => issues.push("the page kept loading; the picture was taken anyway"));
		const pageHeight = await page.evaluate<number>(PAGE_HEIGHT);
		const height = Math.min(Math.max(pageHeight, VIEWPORT.height), MAX_HEIGHT);
		if (pageHeight > MAX_HEIGHT) issues.push(`the page is ${pageHeight} px tall; the picture stops at ${MAX_HEIGHT}`);
		await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: VIEWPORT.width, height }, animations: "disabled" });
		return { file, width: VIEWPORT.width * SCALE, height: height * SCALE, issues };
	} finally {
		await browser?.close().catch(() => undefined);
		await server.close().catch(() => undefined);
	}
}
