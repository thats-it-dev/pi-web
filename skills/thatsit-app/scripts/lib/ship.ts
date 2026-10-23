import { getPage } from "./names.ts";
import { must, type Run } from "./run.ts";
import { appRepo, branchOf, findRun, headSha, localChecks, realClock, requireClean, watchRun, type Clock } from "./wait.ts";

export type ShipOpts = { domainTimeoutMs?: number; runLookupMs?: number; clock?: Clock };

// First version only: pushes main and waits for the production deploy.
export async function ship(
	dir: string,
	run: Run,
	fetchStatus: (url: string) => Promise<number>,
	opts: ShipOpts = {},
): Promise<{ url: string; pending: boolean }> {
	const clock = opts.clock ?? realClock;
	const { name, repo } = appRepo(dir);
	if ((await branchOf(dir, run)) !== "main") throw new Error("ship only works on the main branch; use pr for changes on other branches");
	await requireClean(dir, run);

	// An app commit already deployed to production means this is not the first version.
	// A red first deploy leaves only the template's root commit green, so re-shipping stays possible.
	const roots = (await must(run, "git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: dir })).split("\n").map((s) => s.trim()).filter(Boolean);
	const ok = await must(run, "gh", ["run", "list", "--repo", repo, "--branch", "main", "--workflow", "deploy.yml", "--status", "success", "--json", "headSha"]);
	if ((JSON.parse(ok || "[]") as { headSha: string }[]).some((r) => !roots.includes(r.headSha))) {
		throw new Error(`${name} is already shipped: main has a successful production deploy. Make changes on a branch and open a pull request (pr).`);
	}

	await localChecks(dir, run);
	await must(run, "git", ["push", "origin", "main"], { cwd: dir });
	const sha = await headSha(dir, run);
	await watchRun(repo, await findRun(repo, sha, run, clock, opts.runLookupMs), run);

	const url = `https://${name}.thatsit.app/`;
	const deadline = clock.now() + (opts.domainTimeoutMs ?? 10 * 60_000);
	for (;;) {
		if ((await fetchStatus(url)) === 200) return { url, pending: false };
		if (clock.now() >= deadline) break;
		await clock.sleep(5000);
	}
	// Custom domain still validating: hand back the pages.dev URL instead of hanging.
	const page = await getPage(name, run);
	if (!page) throw new Error(`deployed, but Pages project ${name} was not found to build a fallback URL`);
	return { url: `https://${page.subdomain}/`, pending: true };
}
