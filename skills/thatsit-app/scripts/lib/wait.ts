import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORG, NAME_RE } from "./names.ts";
import { fail, must, type Run } from "./run.ts";

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export const RUN_LOOKUP_MS = 60_000;
export const LOG_TAIL_LINES = 40;

export function appRepo(dir: string): { name: string; repo: string } {
	let name: unknown;
	try {
		name = JSON.parse(readFileSync(join(dir, "app.config.json"), "utf8")).name;
	} catch {
		throw new Error(`${dir} has no readable app.config.json; is it an app checkout?`);
	}
	if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error(`${dir}/app.config.json has no valid name`);
	return { name, repo: `${ORG}/${name}` };
}

export async function branchOf(dir: string, run: Run): Promise<string> {
	return (await must(run, "git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir })).trim();
}

export async function requireClean(dir: string, run: Run): Promise<void> {
	if ((await must(run, "git", ["status", "--porcelain"], { cwd: dir })).trim()) {
		throw new Error("there are uncommitted changes; commit them first (git add -A && git commit)");
	}
}

// Same checks CI runs, so a push is unlikely to go red for something found locally.
export const APP_CHECKS = [["run", "typecheck"], ["test"], ["run", "e2e"]];
export async function localChecks(dir: string, run: Run, checks = APP_CHECKS): Promise<void> {
	for (const args of checks) {
		const r = await run("npm", args, { cwd: dir });
		if (r.code !== 0) {
			const out = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
			throw new Error(`npm ${args.join(" ")} failed; fix it before pushing:\n${out}`);
		}
	}
}

export async function headSha(dir: string, run: Run): Promise<string> {
	return (await must(run, "git", ["rev-parse", "HEAD"], { cwd: dir })).trim();
}

// A run can take a few seconds to show up after a push.
// `workflow` narrows the lookup to one workflow file of a repo that has several.
export async function findRun(repo: string, sha: string, run: Run, clock: Clock, timeoutMs = RUN_LOOKUP_MS, workflow?: string): Promise<number> {
	const start = clock.now();
	for (;;) {
		const args = ["run", "list", "--repo", repo, "--commit", sha, ...(workflow ? ["--workflow", workflow] : []), "--json", "databaseId,status,conclusion"];
		const r = await run("gh", args);
		if (r.code !== 0) throw fail("gh", args, r);
		const runs: { databaseId: number }[] = JSON.parse(r.stdout || "[]");
		if (runs.length > 0) return runs[0].databaseId;
		if (clock.now() - start >= timeoutMs) throw new Error(`no ${workflow ? workflow.replace(/\.ya?ml$/, "") : "deploy"} run appeared for commit ${sha.slice(0, 7)} within ${timeoutMs / 1000}s; check ${repo} Actions`);
		await clock.sleep(5000);
	}
}

// Must match the step name in the template's .github/workflows/deploy.yml.
export const DEPLOY_STEP = "Deploy to Cloudflare Pages";
export const WATCH_TIMEOUT_MS = 20 * 60_000;
const SKIPPED = "deploy step was skipped; check the org Cloudflare secrets and that app.config.json name was changed";

// A green run can still have skipped the deploy (missing token, or the template's not-renamed guard).
export async function deployStepOk(repo: string, id: number, run: Run): Promise<boolean> {
	const args = ["run", "view", String(id), "--repo", repo, "--json", "jobs"];
	const r = await run("gh", args);
	if (r.code !== 0) throw fail("gh", args, r);
	const jobs: { steps?: { name: string; conclusion: string }[] }[] = JSON.parse(r.stdout || "{}").jobs ?? [];
	return jobs.some((j) => j.steps?.some((s) => s.name === DEPLOY_STEP && s.conclusion === "success"));
}

// Blocks until the run ends; on failure the error carries the tail of the failing step logs.
// kind "test" is a plain CI run (no deploy step to check).
export async function watchRun(repo: string, id: number, run: Run, timeoutMs = WATCH_TIMEOUT_MS, kind: "deploy" | "test" = "deploy"): Promise<void> {
	const r = await run("gh", ["run", "watch", String(id), "--repo", repo, "--exit-status"], { timeoutMs });
	if (r.timedOut) throw new Error(`${kind} run ${id} did not finish within ${Math.ceil(timeoutMs / 60_000)} min; it may be queued or stuck: https://github.com/${repo}/actions/runs/${id}`);
	if (r.code === 0) {
		if (kind === "deploy" && !(await deployStepOk(repo, id, run))) throw new Error(`deploy run ${id} finished green but the ${SKIPPED}`);
		return;
	}
	const log = await run("gh", ["run", "view", String(id), "--repo", repo, "--log-failed"]);
	const tail = log.stdout.trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
	throw new Error(`${kind} run ${id} failed in ${repo}. Last lines of the failing step:\n${tail || r.stderr.trim()}`);
}
