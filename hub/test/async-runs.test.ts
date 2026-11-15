import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asyncRunsRoot, reopenSessionsWithActiveRuns, sessionsWithActiveRuns } from "../src/async-runs.ts";

const NOW = 1_794_700_000_000;

function root(runs: Record<string, unknown>[]): string {
	const dir = mkdtempSync(join(tmpdir(), "async-runs-"));
	runs.forEach((status, i) => {
		mkdirSync(join(dir, `run-${i}`));
		writeFileSync(join(dir, `run-${i}`, "status.json"), JSON.stringify(status));
	});
	mkdirSync(join(dir, "broken"));
	writeFileSync(join(dir, "broken", "status.json"), "{not json");
	return dir;
}

test("asyncRunsRoot follows pi-subagents: the env override, else the per-uid tmp dir", () => {
	assert.equal(asyncRunsRoot({ PI_SUBAGENTS_TEMP_ROOT: "/x " }, 7), "/x/async-subagent-runs");
	assert.equal(asyncRunsRoot({}, 1000), "/tmp/pi-subagents-uid-1000/async-subagent-runs");
});

test("sessionsWithActiveRuns: active, recent runs name their session once, latest first; done, old and broken runs don't", () => {
	const dir = root([
		{ state: "running", sessionId: "/s/a.jsonl", lastUpdate: NOW - 60_000 },
		{ state: "queued", sessionId: "/s/b.jsonl", lastActivityAt: NOW - 1_000 },
		{ state: "running", sessionId: "/s/a.jsonl", lastUpdate: NOW - 600_000 },
		{ state: "failed", sessionId: "/s/c.jsonl", lastUpdate: NOW },
		{ state: "running", sessionId: "/s/d.jsonl", lastUpdate: NOW - 2 * 24 * 60 * 60 * 1000 },
		{ state: "running" },
	]);
	assert.deepEqual(sessionsWithActiveRuns(dir, NOW), ["/s/b.jsonl", "/s/a.jsonl"]);
	assert.deepEqual(sessionsWithActiveRuns(join(dir, "missing"), NOW), []);
});

test("reopenSessionsWithActiveRuns opens the indexed sessions that are not live, and logs one it cannot open", async () => {
	const dir = root([
		{ state: "running", sessionId: "/s/a.jsonl", lastUpdate: NOW },
		{ state: "running", sessionId: "/s/live.jsonl", lastUpdate: NOW },
		{ state: "running", sessionId: "/s/unknown.jsonl", lastUpdate: NOW },
		{ state: "running", sessionId: "/s/full.jsonl", lastUpdate: NOW },
	]);
	const ensured: string[] = [];
	const logs: string[] = [];
	const opened = await reopenSessionsWithActiveRuns({
		root: dir,
		now: NOW,
		index: { list: async () => [{ id: "A", file: "/s/a.jsonl" }, { id: "L", file: "/s/live.jsonl" }, { id: "F", file: "/s/full.jsonl" }] },
		registry: {
			get: (id) => (id === "L" ? {} : undefined),
			ensure: async (id) => {
				if (id === "F") throw new Error("too many headless sessions");
				ensured.push(id);
				return {};
			},
		},
		log: (m) => logs.push(m),
	});
	assert.deepEqual(opened, ["A"]);
	assert.deepEqual(ensured, ["A"]);
	assert.match(logs[0], /^reopened session A: an async subagent run/);
	assert.match(logs[1], /^could not reopen session F for its async run: too many headless sessions$/);
	assert.deepEqual(await reopenSessionsWithActiveRuns({ root: join(dir, "none"), index: { list: async () => [] }, registry: { get: () => undefined, ensure: async () => ({}) }, log: () => undefined }), []);
});
