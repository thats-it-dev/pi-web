// Background job manager for bg_bash: detached bash processes logging to a file.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type JobState = "running" | "exited" | "cancelled";

export interface Job {
	id: string;
	command: string;
	cwd: string;
	logPath: string;
	startedAt: number;
	state: JobState;
	exitCode: number | null;
	endedAt: number | null;
}

export const DONE_TYPE = "bg-bash-done";
export const STATUS_KEY = "bg-jobs";

export class Jobs {
	private jobs = new Map<string, Job>();
	private pids = new Map<string, number>();
	private cancelled = new Set<string>();
	private seq = 0;
	private logDir: string;
	private onExit: (job: Job) => void;
	private now: () => number;

	constructor(opts: { logDir: string; onExit: (job: Job) => void; now?: () => number }) {
		this.logDir = opts.logDir;
		this.onExit = opts.onExit;
		this.now = opts.now ?? Date.now;
	}

	start(command: string, cwd: string): Job {
		mkdirSync(this.logDir, { recursive: true });
		const id = `bg-${++this.seq}`;
		const logPath = join(this.logDir, `${id}.log`);
		const job: Job = { id, command, cwd, logPath, startedAt: this.now(), state: "running", exitCode: null, endedAt: null };
		this.jobs.set(id, job);
		const fd = openSync(logPath, "a");
		let child;
		try {
			child = spawn("bash", ["-lc", command], { cwd, detached: true, stdio: ["ignore", fd, fd] });
		} finally {
			closeSync(fd);
		}
		child.unref();
		if (child.pid !== undefined) this.pids.set(id, child.pid);
		let finished = false;
		const finish = (code: number | null) => {
			if (finished) return;
			finished = true;
			this.pids.delete(id);
			job.state = this.cancelled.has(id) ? "cancelled" : "exited";
			job.exitCode = code;
			job.endedAt = this.now();
			this.onExit(job);
		};
		child.on("error", () => finish(127));
		child.on("exit", (code) => finish(code));
		return job;
	}

	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	list(): Job[] {
		return [...this.jobs.values()];
	}

	running(): number {
		return this.list().filter((j) => j.state === "running").length;
	}

	tail(id: string, lines: number): string {
		const job = this.jobs.get(id);
		if (!job) return "";
		return tailOf(readLog(job.logPath), lines);
	}

	cancel(id: string): boolean {
		const job = this.jobs.get(id);
		const pid = this.pids.get(id);
		if (!job || job.state !== "running" || pid === undefined) return false;
		this.cancelled.add(id);
		this.kill(pid);
		return true;
	}

	killAll(): void {
		for (const id of [...this.pids.keys()]) this.cancel(id);
	}

	private kill(pid: number): void {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
}

function readLog(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function tailOf(log: string, lines: number): string {
	const all = log.replace(/\n+$/, "").split("\n");
	return all.slice(-lines).join("\n");
}

function shorten(s: string, max: number): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function doneText(job: Job, log: string, tailLines = 60): string {
	const secs = Math.max(0, Math.round(((job.endedAt ?? job.startedAt) - job.startedAt) / 1000));
	const verb = job.state === "cancelled" ? "was cancelled" : `exited ${job.exitCode}`;
	const head = `bg_bash job ${job.id} ${verb} after ${Math.floor(secs / 60)}m ${secs % 60}s: ${shorten(job.command, 120)}`;
	const tail = tailOf(log, tailLines);
	const tailSet = new Set(tail.split("\n"));
	const result = log.split("\n").filter((l) => l.startsWith("RESULT ")).pop();
	const parts = [head];
	if (result && !tailSet.has(result)) parts.push(result);
	if (tail) parts.push(tail);
	return parts.join("\n");
}
