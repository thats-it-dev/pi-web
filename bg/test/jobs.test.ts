import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, doneText, type Job } from "../jobs.ts";

function setup() {
	const exits: Job[] = [];
	const waiters: ((j: Job) => void)[] = [];
	const jobs = new Jobs({
		logDir: mkdtempSync(join(tmpdir(), "bg-test-")),
		onExit: (j) => {
			exits.push(j);
			waiters.shift()?.(j);
		},
	});
	const nextExit = () => new Promise<Job>((res) => waiters.push(res));
	return { jobs, exits, nextExit };
}

test("start runs the command detached and onExit gets the exit code", async () => {
	const { jobs, nextExit } = setup();
	const p = nextExit();
	const job = jobs.start("echo hi; exit 3", process.cwd());
	const done = await p;
	assert.equal(done.id, job.id);
	assert.equal(done.exitCode, 3);
	assert.equal(done.state, "exited");
	assert.match(readFileSync(job.logPath, "utf8"), /hi/);
});

test("ids count up per manager", () => {
	const { jobs } = setup();
	const a = jobs.start("true", process.cwd());
	const b = jobs.start("true", process.cwd());
	assert.equal(a.id, "bg-1");
	assert.equal(b.id, "bg-2");
});

test("running counts only live jobs", async () => {
	const { jobs, nextExit } = setup();
	const job = jobs.start("sleep 5", process.cwd());
	assert.equal(jobs.running(), 1);
	const p = nextExit();
	assert.equal(jobs.cancel(job.id), true);
	const done = await p;
	assert.equal(done.state, "cancelled");
	assert.equal(jobs.running(), 0);
});

test("cancel kills the whole process group", async () => {
	const { jobs, nextExit } = setup();
	const job = jobs.start("sleep 30 & sleep 30; wait", process.cwd());
	const p = nextExit();
	const t0 = Date.now();
	jobs.cancel(job.id);
	await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("no exit within 2s")), 2000))]);
	assert.ok(Date.now() - t0 < 2000);
});

test("killAll stops every running job", async () => {
	const { jobs, exits } = setup();
	jobs.start("sleep 30", process.cwd());
	jobs.start("sleep 30", process.cwd());
	jobs.killAll();
	const t0 = Date.now();
	while (jobs.running() > 0 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
	assert.equal(jobs.running(), 0);
	assert.equal(exits.length, 2);
});

const base: Job = { id: "bg-7", command: "ship", cwd: "/", logPath: "", startedAt: 0, state: "exited", exitCode: 0, signal: null, endedAt: 75_000 };

test("doneText includes the RESULT line even when it is not in the tail", () => {
	const filler = Array.from({ length: 200 }, (_, i) => `filler ${i}`);
	const result = 'RESULT {"ok":true,"pr":"https://x/pull/1"}';
	const text = doneText(base, [result, ...filler].join("\n") + "\n");
	assert.ok(text.includes(result));
	assert.match(text, /exited 0/);
	assert.match(text, /bg-7/);
	assert.ok(text.split("\n").filter((l) => l.startsWith("filler")).length <= 60);
});

test('doneText starts with "bg_bash job <id> exited <code>"', () => {
	const text = doneText({ ...base, exitCode: 2 }, "x\n");
	assert.equal(text.split("\n")[0].startsWith("bg_bash job bg-7 exited 2"), true);
	assert.match(text.split("\n")[0], /after 1m 15s: ship/);
	assert.match(doneText({ ...base, state: "cancelled", exitCode: null }, "").split("\n")[0], /^bg_bash job bg-7 was cancelled/);
});

test("a new manager on the same log dir does not reuse an old job's log", async () => {
	const logDir = mkdtempSync(join(tmpdir(), "bg-reuse-"));
	const first = await new Promise<Job>((res) => new Jobs({ logDir, onExit: res }).start("echo 'RESULT {\"ok\":false}'", process.cwd()));
	const second = await new Promise<Job>((res) => new Jobs({ logDir, onExit: res }).start("echo fresh", process.cwd()));
	assert.equal(first.id, second.id);
	assert.notEqual(first.logPath, second.logPath);
	assert.equal(readFileSync(second.logPath, "utf8"), "fresh\n");
});

test("a job killed by a signal records the signal", async () => {
	const { jobs, nextExit } = setup();
	const p = nextExit();
	jobs.start("kill -KILL $$", process.cwd());
	const done = await p;
	assert.equal(done.state, "exited");
	assert.equal(done.exitCode, null);
	assert.equal(done.signal, "SIGKILL");
});

test('doneText says "was killed (<signal>)" for a signal-killed job', () => {
	const text = doneText({ ...base, exitCode: null, signal: "SIGKILL" }, "");
	assert.match(text.split("\n")[0], /^bg_bash job bg-7 was killed \(SIGKILL\) after 1m 15s: ship/);
});
