// Self-update from the app: pull master, install, restart. The hub runs as a
// systemd unit with Restart=always, so exiting cleanly is the restart; the
// unit's KillMode=mixed takes any headless pi children with it. Updating
// while a session is mid-turn loses that turn, so the route refuses unless
// told to go ahead.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { UpdateStatus } from "../../shared/src/protocol.ts";

const run = promisify(execFile);

export interface Updater {
	status(): Promise<UpdateStatus>;
	apply(): Promise<{ output: string; commit: string }>;
}

export function gitUpdater(repoRoot: string, version: string): Updater {
	const git = async (...args: string[]) => (await run("git", args, { cwd: repoRoot, timeout: 60_000 })).stdout.trim();
	return {
		async status() {
			let fetchError: string | null = null;
			try {
				await git("fetch", "--quiet", "origin", "master");
			} catch (err) {
				fetchError = (err as Error).message.split("\n")[0];
			}
			const [commit, dirty, behindText, latest] = await Promise.all([
				git("rev-parse", "--short", "HEAD"),
				git("status", "--porcelain", "--untracked-files=no"),
				git("rev-list", "--count", "HEAD..origin/master").catch(() => "0"),
				git("log", "-1", "--format=%h %s", "origin/master").catch(() => ""),
			]);
			return { version, commit, behind: Number(behindText) || 0, latest: latest || null, dirty: dirty.length > 0, fetchError };
		},
		async apply() {
			const pull = await run("git", ["pull", "--ff-only", "origin", "master"], { cwd: repoRoot, timeout: 120_000 });
			const install = await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: repoRoot, timeout: 300_000 });
			const commit = await git("rev-parse", "--short", "HEAD");
			return { output: [pull.stdout, pull.stderr, install.stdout, install.stderr].filter(Boolean).join("\n").trim(), commit };
		},
	};
}
