import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_REPO, gatewayPreviewUrl } from "./names.ts";
import { must, type Run } from "./run.ts";
import { appRepo, branchOf, findRun, headSha, localChecks, realClock, requireClean, watchRun, type Clock } from "./wait.ts";

export type PrOpts = { clock?: Clock; previewWaitMs?: number; watchTimeoutMs?: number };

export type Comment = { user?: { login?: string }; body?: string };

// --paginate prints one JSON array per page back to back.
export function parseComments(out: string): Comment[] {
	return JSON.parse(`[${out.trim().replace(/^\[|\]$/g, "").replace(/\]\s*\[/g, ",")}]`);
}

export async function requireAhead(dir: string, run: Run): Promise<void> {
	await must(run, "git", ["fetch", "origin", "main"], { cwd: dir });
	const ahead = Number((await must(run, "git", ["rev-list", "--count", "origin/main..HEAD"], { cwd: dir })).trim());
	if (!(ahead > 0)) throw new Error("this branch has no commits ahead of origin/main; commit your change first");
}

// The branch's PR, if one is open. `gh pr view` also finds closed/merged PRs for the branch; only an open one is reused.
export async function openPrOf(dir: string, run: Run): Promise<{ url: string; number: number; body: string } | undefined> {
	const r = await run("gh", ["pr", "view", "--json", "url,state,body"], { cwd: dir });
	const info = r.code === 0 ? JSON.parse(r.stdout) : undefined;
	return info?.state === "OPEN" ? { url: info.url, number: prNumber(info.url), body: info.body ?? "" } : undefined;
}

export function prNumber(url: string): number {
	const num = url.match(/\/pull\/(\d+)$/)?.[1];
	if (!num) throw new Error(`could not read the PR number from: ${url}`);
	return Number(num);
}

// Pushes the branch, then opens a PR unless one is already open. A rerun on a branch that has one (fixing a red run) only pushes.
export async function pushAndOpen(dir: string, repo: string, o: { title: string; body: string }, run: Run, existing: { url: string; number: number } | undefined): Promise<{ url: string; number: number }> {
	await must(run, "git", ["push", "-u", "origin", "HEAD"], { cwd: dir });
	if (existing) return existing;
	const url = (await must(run, "gh", ["pr", "create", "--repo", repo, "--title", o.title, "--body", o.body], { cwd: dir })).trim().split("\n").pop()!;
	return { url, number: prNumber(url) };
}

// Apps made from an older template lack the client and the CI step that reads the Gateway line.
export function hasGatewayFiles(dir: string): boolean {
	if (!existsSync(join(dir, "src", "gateway.ts"))) return false;
	try {
		return readFileSync(join(dir, ".github", "workflows", "deploy.yml"), "utf8").includes("gateway-url.ts");
	} catch {
		return false;
	}
}

export const gatewayLine = (n: number) => `Gateway: ${GATEWAY_REPO}#${n}`;

export async function openPr(
	dir: string,
	o: { title: string; body: string; gatewayPr?: number },
	run: Run,
	opts: PrOpts = {},
): Promise<{ pr: string; preview: string; gatewayPreview?: string }> {
	const clock = opts.clock ?? realClock;
	const { name, repo } = appRepo(dir);
	if (o.gatewayPr !== undefined && JSON.parse(readFileSync(join(dir, "app.config.json"), "utf8")).gateway !== true) {
		throw new Error('--gateway-pr needs "gateway": true in app.config.json; set it, commit, then rerun');
	}
	if (o.gatewayPr !== undefined && !hasGatewayFiles(dir)) {
		throw new Error(`${name} predates gateway support; tell Michael (it needs the current template's gateway files)`);
	}
	if ((await branchOf(dir, run)) === "main") throw new Error("pr will not run on main; create one with git switch -c <name>, commit, then run pr");
	await requireClean(dir, run);
	await requireAhead(dir, run);
	await localChecks(dir, run);

	// App CI reads the Gateway line from the PR body of the pull_request event, so it must be there before the push.
	const existing = await openPrOf(dir, run);
	const line = o.gatewayPr === undefined ? undefined : gatewayLine(o.gatewayPr);
	const body = line ? `${o.body}\n\n${line}` : o.body;
	if (existing && line && !existing.body.split("\n").some((l) => l.trim() === line)) {
		const kept = existing.body.split("\n").filter((l) => !l.startsWith(`Gateway: ${GATEWAY_REPO}#`)).join("\n").trimEnd();
		await must(run, "gh", ["pr", "edit", String(existing.number), "--repo", repo, "--body", `${kept}\n\n${line}`], { cwd: dir });
	}
	const { url: prUrl, number: num } = await pushAndOpen(dir, repo, { title: o.title, body }, run, existing);

	const sha = await headSha(dir, run);
	await watchRun(repo, await findRun(repo, sha, run, clock), run, opts.watchTimeoutMs);

	// The sticky comment is edited in place, so an old one may still name an older commit.
	const short = sha.slice(0, 7);
	const wait = opts.previewWaitMs ?? 60_000;
	const start = clock.now();
	for (;;) {
		const out = await must(run, "gh", ["api", `repos/${repo}/issues/${num}/comments`, "--paginate"]);
		const c = parseComments(out).filter((c) => c.user?.login === "github-actions[bot]" && c.body?.includes("<!-- thatsit-preview -->")).pop();
		const url = c?.body?.match(/^Preview: (\S+)/m)?.[1];
		if (url && c?.body?.match(/^Commit (\w+)/m)?.[1] === short) {
			if (o.gatewayPr === undefined) return { pr: prUrl, preview: url };
			// Editing the body starts no run, so a deploy from before the Gateway line was added is not wired to it.
			const gw = gatewayPreviewUrl(o.gatewayPr);
			if (!c.body!.split("\n").some((l) => l.trim() === `Gateway preview: ${gw}`)) {
				throw new Error(`the preview ${url} is not using gateway preview #${o.gatewayPr} (it was deployed before the Gateway line was in the PR body); run cd ${dir} && git commit --allow-empty -m "Use gateway preview #${o.gatewayPr}", then rerun the same pr`);
			}
			return { pr: prUrl, preview: url, gatewayPreview: gw };
		}
		if (clock.now() - start >= wait) throw new Error(`the PR ${prUrl} deployed, but no preview link for commit ${short} was posted within ${wait / 1000}s; check the PR comments`);
		await clock.sleep(5000);
	}
}
