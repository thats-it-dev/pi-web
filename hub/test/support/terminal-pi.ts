// A stand-in for pi running in a terminal: `pi --mode rpc` with the bridge
// extension loaded, driven over stdin the way a person drives the TUI. Its
// stdout records (events, responses, extension UI requests) are recorded.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lineSplitter } from "../../../shared/src/jsonl.ts";
import { Recorder } from "./recorder.ts";

export const BRIDGE_ENTRY = fileURLToPath(new URL("../../../bridge/index.ts", import.meta.url));

export interface TerminalPiOptions {
	piBin: string;
	cwd: string;
	env: Record<string, string>; // e.g. PI_CODING_AGENT_DIR
	socketPath: string;
	sessionFile?: string;
	loadBridge?: boolean; // default true; false when settings.json already loads it
	extraEnv?: Record<string, string>;
}

export interface TerminalPi {
	proc: ChildProcessWithoutNullStreams;
	pid: number;
	records: Recorder<any>;
	stderr(): string;
	send(cmd: Record<string, unknown>): void;
	call(cmd: Record<string, unknown>): Promise<any>; // resolves with pi's response record
	quit(): Promise<void>;
}

let seq = 0;

export function startTerminalPi(opts: TerminalPiOptions): TerminalPi {
	const args = ["--mode", "rpc"];
	if (opts.loadBridge ?? true) args.push("-e", BRIDGE_ENTRY);
	if (opts.sessionFile) args.push("--session", opts.sessionFile);
	const proc = spawn(opts.piBin, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env, PI_WEB: "", PI_WEB_BRIDGE_SOCKET: opts.socketPath, ...opts.extraEnv } });
	const records = new Recorder<any>();
	let stderr = "";
	proc.stdout.setEncoding("utf8");
	proc.stdout.on(
		"data",
		lineSplitter((line) => {
			try {
				records.push(JSON.parse(line));
			} catch {}
		}),
	);
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (d: string) => (stderr += d));
	proc.stdin.on("error", () => {});
	const exited = new Promise<void>((resolve) => proc.on("close", () => resolve()));
	const write = (cmd: Record<string, unknown>) => proc.stdin.write(`${JSON.stringify(cmd)}\n`);
	return {
		proc,
		pid: proc.pid ?? -1,
		records,
		stderr: () => stderr,
		send: write,
		call(cmd) {
			const id = `term-${++seq}`;
			write({ ...cmd, id });
			return records.waitFor((r) => r.type === "response" && r.id === id, 30_000);
		},
		async quit() {
			proc.stdin.end();
			const timer = setTimeout(() => proc.kill("SIGTERM"), 5000);
			await exited;
			clearTimeout(timer);
		},
	};
}
