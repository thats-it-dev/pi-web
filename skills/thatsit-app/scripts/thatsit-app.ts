#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { checkName } from "./lib/names.ts";
import { newApp } from "./lib/new-app.ts";
import { openPr } from "./lib/pr.ts";
import { realRun } from "./lib/run.ts";
import { ship } from "./lib/ship.ts";

export type Args =
	| { cmd: "check"; name: string }
	| { cmd: "ship"; name: string }
	| { cmd: "pr"; name: string; title: string; body: string }
	| { cmd: "new"; name: string; title: string; description: string; color: string; resume: boolean };

export const DEFAULT_COLOR = "#FFAA00";

// null means a usage error.
export function parseArgs(argv: string[]): Args | null {
	const [cmd, name, ...rest] = argv;
	if (!name || name.startsWith("--")) return null;
	if (cmd === "check") return rest.length === 0 ? { cmd, name } : null;
	if (cmd === "ship") return rest.length === 0 ? { cmd, name } : null;
	if (cmd === "pr") {
		if (rest.length !== 4) return null;
		const o: Record<string, string> = {};
		for (let i = 0; i < 4; i += 2) {
			if (rest[i] !== "--title" && rest[i] !== "--body") return null;
			o[rest[i].slice(2)] = rest[i + 1];
		}
		return o.title && o.body ? { cmd, name, title: o.title, body: o.body } : null;
	}
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

// Status code only; a network error is "not up yet".
const fetchStatus = async (url: string) => {
	try {
		return (await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) })).status;
	} catch {
		return 0;
	}
};

const result = (v: unknown) => console.log(`RESULT ${JSON.stringify(v)}`);

async function main(): Promise<number> {
	const a = parseArgs(process.argv.slice(2));
	if (!a) {
		console.error('usage: thatsit-app check <name> | ship <dir> | pr <dir> --title "..." --body "..." | new <name> --title "..." --description "..." [--color "#RRGGBB"] [--resume]');
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
		if (a.cmd === "ship") {
			const r = await ship(a.name, realRun, fetchStatus);
			if (r.pending) console.error("The custom domain is still validating; use the pages.dev URL for now.");
			result({ ok: true, ...r });
			return 0;
		}
		if (a.cmd === "pr") {
			result({ ok: true, ...(await openPr(a.name, { title: a.title, body: a.body }, realRun)) });
			return 0;
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
