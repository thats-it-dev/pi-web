// After a hub restart every async subagent run its sessions had going is dead: the runners are the hub's children
// (KillMode=mixed), and a kernel OOM kill of one child used to take the unit down (deploy/pi-web-hub.service). Nothing
// said so until the parent session was next opened, because pi-subagents restores and reconciles its runs when the
// session starts (fret 2026-11-14: a worker killed at 10:26 was reported dead at 11:08, when Michael asked). So the hub
// reopens those sessions itself; the dead run is then reported into the session, and the agent carries on.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** pi-subagents' run states that mean "still going" (its status.json `state`). */
export const ACTIVE_STATES = new Set(["queued", "running"]);
/** A run that last moved longer ago than this is left alone: a leftover, not a session's current work. */
export const MAX_RUN_AGE_MS = 24 * 60 * 60 * 1000;

/** Where pi-subagents keeps async runs (the same root the guard reads). */
export function asyncRunsRoot(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 1000): string {
	return join(env.PI_SUBAGENTS_TEMP_ROOT?.trim() || `/tmp/pi-subagents-uid-${uid}`, "async-subagent-runs");
}

/** The parent session files (status.json `sessionId`) of the runs still marked active, most recently active first. */
export function sessionsWithActiveRuns(root: string, now = Date.now(), maxAgeMs = MAX_RUN_AGE_MS): string[] {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	const latest = new Map<string, number>();
	for (const name of names) {
		let s: { state?: unknown; sessionId?: unknown; lastUpdate?: unknown; lastActivityAt?: unknown };
		try {
			s = JSON.parse(readFileSync(join(root, name, "status.json"), "utf8"));
		} catch {
			continue;
		}
		if (typeof s.state !== "string" || !ACTIVE_STATES.has(s.state) || typeof s.sessionId !== "string") continue;
		const at = Math.max(typeof s.lastUpdate === "number" ? s.lastUpdate : 0, typeof s.lastActivityAt === "number" ? s.lastActivityAt : 0);
		if (now - at > maxAgeMs) continue;
		latest.set(s.sessionId, Math.max(latest.get(s.sessionId) ?? 0, at));
	}
	return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([file]) => file);
}

export type ReopenDeps = {
	root: string;
	index: { list(): Promise<{ id: string; file: string }[]> };
	registry: { get(id: string): unknown; ensure(id: string): Promise<unknown> };
	log: (m: string) => void;
	now?: number;
};

/** Opens (headless) every session the index knows that has an active run and no live handle; the ids opened. */
export async function reopenSessionsWithActiveRuns(d: ReopenDeps): Promise<string[]> {
	const files = sessionsWithActiveRuns(d.root, d.now);
	if (!files.length) return [];
	const idByFile = new Map((await d.index.list()).map((s) => [s.file, s.id]));
	const opened: string[] = [];
	for (const file of files) {
		const id = idByFile.get(file);
		if (!id || d.registry.get(id)) continue;
		try {
			await d.registry.ensure(id);
			opened.push(id);
			d.log(`reopened session ${id}: an async subagent run of its was still marked active, so pi-subagents can report it`);
		} catch (err) {
			d.log(`could not reopen session ${id} for its async run: ${(err as Error).message}`);
		}
	}
	return opened;
}
