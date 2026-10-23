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
export async function localChecks(dir: string, run: Run): Promise<void> {
	for (const args of [["run", "typecheck"], ["test"], ["run", "e2e"]]) {
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
export async function findRun(repo: string, sha: string, run: Run, clock: Clock, timeoutMs = RUN_LOOKUP_MS): Promise<number> {
	const start = clock.now();
	for (;;) {
		const args = ["run", "list", "--repo", repo, "--commit", sha, "--json", "databaseId,status,conclusion"];
		const r = await run("gh", args);
		if (r.code !== 0) throw fail("gh", args, r);
		const runs: { databaseId: number }[] = JSON.parse(r.stdout || "[]");
		if (runs.length > 0) return runs[0].databaseId;
		if (clock.now() - start >= timeoutMs) throw new Error(`no deploy run appeared for commit ${sha.slice(0, 7)} within ${timeoutMs / 1000}s; check ${repo} Actions`);
		await clock.sleep(5000);
	}
}

// Blocks until the run ends; on failure the error carries the tail of the failing step logs.
export async function watchRun(repo: string, id: number, run: Run): Promise<void> {
	const r = await run("gh", ["run", "watch", String(id), "--repo", repo, "--exit-status"]);
	if (r.code === 0) return;
	const log = await run("gh", ["run", "view", String(id), "--repo", repo, "--log-failed"]);
	const tail = log.stdout.trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
	throw new Error(`deploy run ${id} failed in ${repo}. Last lines of the failing step:\n${tail || r.stderr.trim()}`);
}
