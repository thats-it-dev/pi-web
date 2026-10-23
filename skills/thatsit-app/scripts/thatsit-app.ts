#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { checkName } from "./lib/names.ts";
import { newApp } from "./lib/new-app.ts";
import { realRun } from "./lib/run.ts";

export type Args =
	| { cmd: "check"; name: string }
	| { cmd: "new"; name: string; title: string; description: string; color: string; resume: boolean };

export const DEFAULT_COLOR = "#FFAA00";

// null means a usage error.
export function parseArgs(argv: string[]): Args | null {
	const [cmd, name, ...rest] = argv;
	if (!name || name.startsWith("--")) return null;
	if (cmd === "check") return rest.length === 0 ? { cmd, name } : null;
	if (cmd !== "new") return null;
	const o: Record<string, string> = {};
	let resume = false;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--resume") resume = true;
		else if (["--title", "--description", "--color"].includes(rest[i]) && rest[i + 1] !== undefined) o[rest[i].slice(2)] = rest[++i];
		else return null;
	}
	if (!o.title || !o.description) return null;
	return { cmd, name, title: o.title, description: o.description, color: o.color ?? DEFAULT_COLOR, resume };
}

const result = (v: unknown) => console.log(`RESULT ${JSON.stringify(v)}`);

async function main(): Promise<number> {
	const a = parseArgs(process.argv.slice(2));
	if (!a) {
		console.error('usage: thatsit-app check <name> | new <name> --title "..." --description "..." [--color "#RRGGBB"] [--resume]');
		return 2;
	}
	try {
		if (a.cmd === "check") {
			const r = await checkName(a.name, realRun);
			if (r.ok) result({ ok: true, name: a.name });
			else {
				console.error(r.reason);
				result({ ok: false, reason: r.reason });
			}
			return r.ok ? 0 : 1;
		}
		const appsDir = process.env.THATSIT_APPS_DIR ?? join(homedir(), "workspace", "apps");
		const r = await newApp({ ...a, appsDir }, realRun);
		result({ ok: true, name: a.name, dir: r.dir, pagesSubdomain: r.pagesSubdomain, url: `https://${a.name}.thatsit.app` });
		return 0;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(msg);
		result({ ok: false, reason: msg });
		return 1;
	}
}

if (import.meta.main) process.exitCode = await main();
