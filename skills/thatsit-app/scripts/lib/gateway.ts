import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_REPO, NAME_RE, getPage } from "./names.ts";
import { ghIdentity, setIdentity } from "./new-app.ts";
import { openPrOf, parseComments, pushAndOpen, requireAhead } from "./pr.ts";
import { must, type Run } from "./run.ts";
import { branchOf, findRun, headSha, localChecks, realClock, requireClean, watchRun, type Clock } from "./wait.ts";

export { gatewayPreviewUrl } from "./names.ts";

export const GATEWAY_DIRNAME = "spark-gateway";
// The gateway repo's CI workflow (.github/workflows/test.yml) and the spark's commit status context.
export const GATEWAY_WORKFLOW = "test.yml";
export const PREVIEW_CONTEXT = "spark-preview";
const MARKER = "<!-- spark-preview -->";
export const GATEWAY_WAIT_MS = 20 * 60_000;
const POLL_MS = 15_000;

async function requireGatewayClone(dir: string, run: Run): Promise<void> {
	const r = await run("git", ["remote", "get-url", "origin"], { cwd: dir });
	if (r.code !== 0 || !r.stdout.trim().replace(/\.git$/, "").endsWith(GATEWAY_REPO)) {
		throw new Error(`${dir} is not a clone of ${GATEWAY_REPO}`);
	}
}

// Clone (first time) or update the gateway checkout, and leave it on an up-to-date main.
export async function gatewayCheckout(appsDir: string, run: Run): Promise<{ dir: string }> {
	const dir = join(appsDir, GATEWAY_DIRNAME);
	const id = await ghIdentity(run);
	if (existsSync(dir)) await requireGatewayClone(dir, run);
	else {
		mkdirSync(appsDir, { recursive: true });
		await must(run, "gh", ["repo", "clone", GATEWAY_REPO, dir]);
	}
	await setIdentity(dir, id, run);
	if ((await must(run, "git", ["status", "--porcelain"], { cwd: dir })).trim()) {
		throw new Error(`${dir} has uncommitted changes; commit them on their branch (or ask Michael) before gateway-checkout`);
	}
	await must(run, "git", ["switch", "main"], { cwd: dir });
	await must(run, "git", ["pull", "--ff-only"], { cwd: dir });
	await must(run, "npm", ["ci"], { cwd: dir });
	return { dir };
}

type AppEntry = { name: string; pagesSubdomain: string };

// Adds the app to apps.json on a branch (register-<app> when starting from main) and commits it.
export async function gatewayRegister(appsDir: string, app: string, run: Run): Promise<{ dir: string; branch: string; name: string; pagesSubdomain: string }> {
	if (!NAME_RE.test(app)) throw new Error(`invalid name "${app}"`);
	const dir = join(appsDir, GATEWAY_DIRNAME);
	if (!existsSync(join(dir, ".git"))) throw new Error(`${dir} is missing; run gateway-checkout first`);
	await requireGatewayClone(dir, run);
	await requireClean(dir, run);

	const file = join(dir, "apps.json");
	const apps: AppEntry[] = JSON.parse(readFileSync(file, "utf8"));
	if (!Array.isArray(apps)) throw new Error(`${file} is not a JSON array`);
	if (apps.some((a) => a.name === app)) throw new Error(`${app} is already registered in apps.json`);

	const page = await getPage(app, run);
	if (!page) throw new Error(`${app} has no Pages project; create the app with new first`);
	const pagesSubdomain = String(page.subdomain ?? "").replace(/\.pages\.dev$/, "");
	if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(pagesSubdomain)) throw new Error(`cf pages get ${app} returned an unexpected subdomain: ${page.subdomain}`);

	let branch = await branchOf(dir, run);
	if (branch === "main") {
		branch = `register-${app}`;
		await must(run, "git", ["switch", "-c", branch], { cwd: dir });
	}
	writeFileSync(file, `${JSON.stringify([...apps, { name: app, pagesSubdomain }], null, "\t")}\n`);
	await must(run, "git", ["add", "apps.json"], { cwd: dir });
	await must(run, "git", ["commit", "-m", `Register ${app}`], { cwd: dir });
	return { dir, branch, name: app, pagesSubdomain };
}

// pi may only change the app list and per-app modules, never the gateway itself.
const ALLOWED = (p: string) => p === "apps.json" || /^apps\/[a-z][a-z0-9-]*\/[^/].*/.test(p);

export type GatewayPrOpts = { clock?: Clock; timeoutMs?: number };

export async function gatewayPr(
	dir: string,
	o: { title: string; body: string },
	run: Run,
	opts: GatewayPrOpts = {},
): Promise<{ pr: string; number: number; preview: string }> {
	const clock = opts.clock ?? realClock;
	const repo = GATEWAY_REPO;
	await requireGatewayClone(dir, run);
	if ((await branchOf(dir, run)) === "main") throw new Error("gateway-pr will not run on main; create one with git switch -c <name>, commit, then run gateway-pr");
	await requireClean(dir, run);
	await requireAhead(dir, run);
	const changed = (await must(run, "git", ["diff", "--name-only", "--no-renames", "origin/main...HEAD"], { cwd: dir })).split("\n").map((s) => s.trim()).filter(Boolean);
	const bad = changed.filter((p) => !ALLOWED(p) || p.startsWith("apps/example/"));
	if (bad.length) throw new Error(`gateway-pr only sends apps.json and apps/<app>/ changes; this branch also changes: ${bad.join(", ")}. Undo those (never edit src/)`);
	await localChecks(dir, run, [["run", "typecheck"], ["test"]]);

	const existing = await openPrOf(dir, run);
	const { url: prUrl, number: n } = await pushAndOpen(dir, repo, o, run, existing);

	// One 20-minute budget for GitHub CI and the spark's own test + start of the preview.
	const deadline = clock.now() + (opts.timeoutMs ?? GATEWAY_WAIT_MS);
	const sha = await headSha(dir, run);
	await watchRun(repo, await findRun(repo, sha, run, clock, undefined, GATEWAY_WORKFLOW), run, Math.max(deadline - clock.now(), 60_000), "test");

	const minutes = Math.round((opts.timeoutMs ?? GATEWAY_WAIT_MS) / 60_000);
	let failedAt: number | undefined;
	for (;;) {
		const st = JSON.parse(await must(run, "gh", ["api", `repos/${repo}/commits/${sha}/status`]));
		const status: { state?: string; description?: string } | undefined = (st.statuses ?? []).find((s: { context?: string }) => s.context === PREVIEW_CONTEXT);
		const state = status?.state;
		const body = await stickyBody(repo, n, run);
		const text = body?.replace(MARKER, "").trim();
		if (text?.startsWith("No preview")) throw new Error(`${prUrl}: ${text}`);
		// The comment is edited in place, so it only counts once it names this head.
		if (state === "success" && body && new RegExp(`^Head: ${sha}$`, "m").test(body)) {
			const url = body.match(/^Preview gateway: (https:\/\/\S+)/m)?.[1];
			if (url) return { pr: prUrl, number: n, preview: url };
		}
		if (state === "failure") {
			const forHead = body?.includes(`Preview of ${sha} failed`) ? body : undefined;
			// The status lands just before the comment; don't wait long for a comment that may never come.
			failedAt ??= clock.now();
			if (forHead || clock.now() - failedAt >= 60_000) {
				const tail = forHead?.match(/```\n([\s\S]*?)\n```/)?.[1];
				const reason = forHead?.match(/failed: (.*?)\.(?:\n|$)/)?.[1] ?? status?.description ?? "see the PR comment";
				throw new Error(`spark preview of ${sha.slice(0, 7)} failed (${reason}) on ${prUrl}.${tail ? ` Last lines of the spark's test run:\n${tail}` : ""}`);
			}
		}
		if (clock.now() >= deadline) {
			throw new Error(`the spark did not report a preview for ${sha.slice(0, 7)} within ${minutes} min (status: ${state ?? "none"}); check ${prUrl}`);
		}
		await clock.sleep(POLL_MS);
	}
}

async function stickyBody(repo: string, n: number, run: Run): Promise<string | undefined> {
	const out = await must(run, "gh", ["api", `repos/${repo}/issues/${n}/comments`, "--paginate"]);
	return parseComments(out).filter((c) => c.body?.includes(MARKER)).pop()?.body;
}
