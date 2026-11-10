// bg: run long shell commands in the background and wake pi when they exit.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { DONE_TYPE, Jobs, STATUS_KEY, doneText, type Job } from "./jobs.ts";

interface CtxLike {
	cwd: string;
	ui: { setStatus(key: string, text: string | undefined): void };
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	details?: unknown;
	isError?: boolean;
}

interface PiLike {
	on(event: string, handler: (event: any, ctx: any) => unknown): unknown;
	sendMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute(id: string, params: any, signal: unknown, onUpdate: unknown, ctx: CtxLike): Promise<ToolResult>;
	}): void;
}

const reply = (text: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content: [{ type: "text", text }], ...extra });

export default function bg(pi: PiLike, opts: { logDir?: string } = {}): void {
	let ctx: CtxLike | undefined;
	let closing = false;

	const refreshStatus = () => {
		const n = jobs.running();
		ctx?.ui.setStatus(STATUS_KEY, n === 0 ? undefined : `${n} background job${n === 1 ? "" : "s"}`);
	};

	const jobs: Jobs = new Jobs({
		logDir: opts.logDir ?? join(tmpdir(), "pi-bg", String(process.pid)),
		onExit: (job: Job) => {
			if (closing) return;
			refreshStatus();
			let log = "";
			try {
				log = readFileSync(job.logPath, "utf8");
			} catch {
				// no output
			}
			pi.sendMessage(
				{ customType: DONE_TYPE, content: doneText(job, log), display: true, details: { id: job.id, state: job.state, exitCode: job.exitCode } },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});

	pi.registerTool({
		name: "bg_bash",
		label: "Background bash",
		description:
			"Run a long shell command in the background. Returns a job id at once; when the command exits you get a bg-bash-done message with its exit code and last lines of output, and a new turn starts. Use it for commands that wait on CI (pr-wait, gateway-pr-wait, ship). Do not poll; end your turn and wait for the message.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run" }),
			cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the session's" })),
		}),
		async execute(_id, params: { command: string; cwd?: string }, _signal, _onUpdate, c) {
			ctx = c;
			const job = jobs.start(params.command, params.cwd ?? c.cwd);
			refreshStatus();
			return reply(`started job ${job.id}. You will get a ${DONE_TYPE} message when it exits; end your turn and wait.`, { details: { id: job.id } });
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background jobs",
		description: "Show background jobs: state, run time and the last lines of output. Only when Michael asks.",
		parameters: Type.Object({ id: Type.Optional(Type.String({ description: "Job id; omit for all jobs" })) }),
		async execute(_id, params: { id?: string }, _signal, _onUpdate, c) {
			ctx = c;
			let list = jobs.list();
			if (params.id !== undefined) {
				const job = jobs.get(params.id);
				if (!job) return reply(`no such job: ${params.id}`, { isError: true });
				list = [job];
			}
			if (list.length === 0) return reply("no background jobs");
			const now = Date.now();
			const blocks = list.map((j) => {
				const secs = Math.round(((j.endedAt ?? now) - j.startedAt) / 1000);
				const state = j.state === "exited" ? `exited ${j.exitCode}` : j.state;
				return `${j.id} ${state} (${Math.floor(secs / 60)}m ${secs % 60}s): ${j.command}\n${jobs.tail(j.id, 10)}`.trimEnd();
			});
			return reply(blocks.join("\n\n"));
		},
	});

	pi.registerTool({
		name: "bg_cancel",
		label: "Cancel background job",
		description: "Stop a background job by id.",
		parameters: Type.Object({ id: Type.String({ description: "Job id" }) }),
		async execute(_id, params: { id: string }, _signal, _onUpdate, c) {
			ctx = c;
			if (!jobs.cancel(params.id)) return reply(`no running job ${params.id}`, { isError: true });
			return reply(`cancelled job ${params.id}`);
		},
	});

	pi.on("session_shutdown", () => {
		closing = true;
		jobs.killAll();
		ctx?.ui.setStatus(STATUS_KEY, undefined);
	});
}
