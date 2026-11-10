import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORG, NAME_RE } from "./names.ts";
import { fail, must, type Run } from "./run.ts";

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export const RUN_LOOKUP_MS = 60_000;
export const PROGRESS_MS = 30_000;

// Progress goes to stderr, so a long wait shows what it is waiting on; RESULT stays the last stdout line.
export type Log = (line: string) => void;
export const stderrLog: Log = (line) => void process.stderr.write(`${line}\n`);
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

// The step a running job is on, for progress lines.
export function currentStep(viewJson: string): string {
	try {
		const jobs: { steps?: { name: string; status?: string }[] }[] = JSON.parse(viewJson || "{}").jobs ?? [];
		return jobs.flatMap((j) => j.steps ?? []).find((s) => s.status === "in_progress")?.name ?? "starting";
	} catch {
		return "starting";
	}
}

const mmss = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

// Blocks until the run ends; on failure the error carries the tail of the failing step logs.
// kind "test" is a plain CI run (no deploy step to check). Every progressMs it logs the step CI is on.
export async function watchRun(
	repo: string,
	id: number,
	run: Run,
	timeoutMs = WATCH_TIMEOUT_MS,
	kind: "deploy" | "test" = "deploy",
	log: Log = stderrLog,
	progressMs = PROGRESS_MS,
): Promise<void> {
	const started = Date.now();
	log(`waiting for CI: ${kind} run ${id} (https://github.com/${repo}/actions/runs/${id}); usually 3-6 min`);
	const ticker = setInterval(() => {
		void run("gh", ["run", "view", String(id), "--repo", repo, "--json", "jobs"]).then((v) => log(`waiting for CI (${mmss(Date.now() - started)}): ${currentStep(v.stdout)}`));
	}, progressMs);
	ticker.unref?.();
	let r;
	try {
		r = await run("gh", ["run", "watch", String(id), "--repo", repo, "--exit-status"], { timeoutMs });
	} finally {
		clearInterval(ticker);
	}
	if (r.timedOut) throw new Error(`${kind} run ${id} did not finish within ${Math.ceil(timeoutMs / 60_000)} min; it may be queued or stuck: https://github.com/${repo}/actions/runs/${id}`);
	if (r.code === 0) {
		if (kind === "deploy" && !(await deployStepOk(repo, id, run))) throw new Error(`deploy run ${id} finished green but the ${SKIPPED}`);
		return;
	}
	const failed = await run("gh", ["run", "view", String(id), "--repo", repo, "--log-failed"]);
	const tail = failed.stdout.trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
	throw new Error(`${kind} run ${id} failed in ${repo}. Last lines of the failing step:\n${tail || r.stderr.trim()}`);
}
