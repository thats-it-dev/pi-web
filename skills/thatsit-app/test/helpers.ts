import type { Run } from "../scripts/lib/run.ts";

export type Reply = { code?: number; stdout?: string; stderr?: string };
export type Call = { cmd: string; args: string[]; cwd?: string };

// Fake Run: answers from a table keyed by "cmd arg arg..." prefix (longest match wins).
export function fakeRun(table: Record<string, Reply | ((c: Call) => Reply)>) {
	const calls: Call[] = [];
	const run: Run = async (cmd, args, opts) => {
		const call = { cmd, args, cwd: opts?.cwd };
		calls.push(call);
		const line = [cmd, ...args].join(" ");
		const key = Object.keys(table)
			.filter((k) => line === k || line.startsWith(`${k} `))
			.sort((a, b) => b.length - a.length)[0];
		if (key === undefined) return { code: 127, stdout: "", stderr: `unexpected: ${line}` };
		const r = table[key];
		const v = typeof r === "function" ? r(call) : r;
		return { code: v.code ?? 0, stdout: v.stdout ?? "", stderr: v.stderr ?? "" };
	};
	return { run, calls, lines: () => calls.map((c) => [c.cmd, ...c.args].join(" ")) };
}
