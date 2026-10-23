import { must, type Run } from "./run.ts";
import { appRepo, branchOf, findRun, headSha, localChecks, realClock, requireClean, watchRun, type Clock } from "./wait.ts";

export type PrOpts = { clock?: Clock; previewWaitMs?: number };

type Comment = { user?: { login?: string }; body?: string };

// --paginate prints one JSON array per page back to back.
function parseComments(out: string): Comment[] {
	return JSON.parse(`[${out.trim().replace(/^\[|\]$/g, "").replace(/\]\s*\[/g, ",")}]`);
}

export async function openPr(
	dir: string,
	o: { title: string; body: string },
	run: Run,
	opts: PrOpts = {},
): Promise<{ pr: string; preview: string }> {
	const clock = opts.clock ?? realClock;
	const { repo } = appRepo(dir);
	if ((await branchOf(dir, run)) === "main") throw new Error("pr will not run on main; create one with git switch -c <name>, commit, then run pr");
	await requireClean(dir, run);
	await must(run, "git", ["fetch", "origin", "main"], { cwd: dir });
	const ahead = Number((await must(run, "git", ["rev-list", "--count", "origin/main..HEAD"], { cwd: dir })).trim());
	if (!(ahead > 0)) throw new Error("this branch has no commits ahead of origin/main; commit your change first");

	await localChecks(dir, run);
	await must(run, "git", ["push", "-u", "origin", "HEAD"], { cwd: dir });
	const prUrl = (await must(run, "gh", ["pr", "create", "--repo", repo, "--title", o.title, "--body", o.body], { cwd: dir })).trim().split("\n").pop()!;
	const num = prUrl.match(/\/pull\/(\d+)$/)?.[1];
	if (!num) throw new Error(`could not read the PR number from: ${prUrl}`);

	const sha = await headSha(dir, run);
	await watchRun(repo, await findRun(repo, sha, run, clock), run);

	// The sticky comment is edited in place, so an old one may still name an older commit.
	const short = sha.slice(0, 7);
	const wait = opts.previewWaitMs ?? 60_000;
	const start = clock.now();
	for (;;) {
		const out = await must(run, "gh", ["api", `repos/${repo}/issues/${num}/comments`, "--paginate"]);
		const c = parseComments(out).filter((c) => c.user?.login === "github-actions[bot]" && c.body?.includes("<!-- thatsit-preview -->")).pop();
		const url = c?.body?.match(/^Preview: (\S+)/m)?.[1];
		if (url && c?.body?.match(/^Commit (\w+)/m)?.[1] === short) return { pr: prUrl, preview: url };
		if (clock.now() - start >= wait) throw new Error(`the PR ${prUrl} deployed, but no preview link for commit ${short} was posted within ${wait / 1000}s; check the PR comments`);
		await clock.sleep(5000);
	}
}
