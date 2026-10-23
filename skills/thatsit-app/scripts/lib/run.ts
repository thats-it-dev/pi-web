import { execFile } from "node:child_process";

export type RunResult = { code: number; stdout: string; stderr: string; timedOut?: true };
export type Run = (cmd: string, args: string[], opts?: { cwd?: string; input?: string; timeoutMs?: number }) => Promise<RunResult>;

// Never throws on non-zero exit and never echoes output: callers decide what to show.
export const realRun: Run = (cmd, args, opts = {}) =>
	new Promise((resolve) => {
		const child = execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 32 * 1024 * 1024, timeout: opts.timeoutMs }, (err, stdout, stderr) => {
			if (!err) return resolve({ code: 0, stdout, stderr });
			// execFile kills the child on timeout; report it distinctly from a normal failure.
			if ((err as { killed?: boolean }).killed && opts.timeoutMs) return resolve({ code: 1, stdout, stderr: `timed out after ${opts.timeoutMs} ms`, timedOut: true });
			const code = typeof err.code === "number" ? err.code : 1;
			resolve({ code, stdout, stderr: stderr || err.message });
		});
		// Close stdin right away so a prompting command fails instead of hanging.
		child.stdin?.end(opts.input);
	});

export function fail(cmd: string, args: string[], r: RunResult): Error {
	return new Error(`${[cmd, ...args].join(" ")} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
}

// Run and throw with the command's stderr on failure.
export async function must(run: Run, cmd: string, args: string[], opts?: { cwd?: string }): Promise<string> {
	const r = await run(cmd, args, opts);
	if (r.code !== 0) throw fail(cmd, args, r);
	return r.stdout;
}
