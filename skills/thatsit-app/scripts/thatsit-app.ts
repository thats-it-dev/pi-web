#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { gatewayCheckout, gatewayPr, gatewayRegister } from "./lib/gateway.ts";
import { checkName, MAX_GATEWAY_PR } from "./lib/names.ts";
import { newApp } from "./lib/new-app.ts";
import { openPr } from "./lib/pr.ts";
import { realRun } from "./lib/run.ts";
import { ship } from "./lib/ship.ts";

export type Args =
	| { cmd: "check"; name: string }
	| { cmd: "ship"; name: string }
	| { cmd: "pr"; name: string; title: string; body: string; gatewayPr?: number }
	| { cmd: "gateway-checkout" }
	| { cmd: "gateway-register"; name: string }
	| { cmd: "gateway-pr"; name: string; title: string; body: string }
	| { cmd: "new"; name: string; title: string; description: string; color: string; resume: boolean };

export const DEFAULT_COLOR = "#FFAA00";

// null means a usage error.
export function parseArgs(argv: string[]): Args | null {
	const [cmd, name, ...rest] = argv;
	if (cmd === "gateway-checkout") return argv.length === 1 ? { cmd } : null;
	if (!name || name.startsWith("--")) return null;
	if (cmd === "check" || cmd === "ship" || cmd === "gateway-register") return rest.length === 0 ? { cmd, name } : null;
	if (cmd === "pr" || cmd === "gateway-pr") {
		const flags = cmd === "pr" ? ["--title", "--body", "--gateway-pr"] : ["--title", "--body"];
		const o: Record<string, string> = {};
		for (let i = 0; i < rest.length; i += 2) {
			if (!flags.includes(rest[i]) || rest[i + 1] === undefined || rest[i].slice(2) in o) return null;
			o[rest[i].slice(2)] = rest[i + 1];
		}
		if (!o.title || !o.body) return null;
		if (o["gateway-pr"] === undefined) return { cmd, name, title: o.title, body: o.body };
		// Accept "12" or "#12"; only 1-499 have a gateway preview.
		const n = /^#?[1-9]\d*$/.test(o["gateway-pr"]) ? Number(o["gateway-pr"].replace("#", "")) : 0;
		return n >= 1 && n <= MAX_GATEWAY_PR ? { cmd: "pr", name, title: o.title, body: o.body, gatewayPr: n } : null;
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
		console.error('usage: thatsit-app check <name> | ship <dir> | pr <dir> --title "..." --body "..." [--gateway-pr <N>] | new <name> --title "..." --description "..." [--color "#RRGGBB"] [--resume] | gateway-checkout | gateway-register <app> | gateway-pr <dir> --title "..." --body "..."');
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
			result({ ok: true, ...(await openPr(a.name, { title: a.title, body: a.body, gatewayPr: a.gatewayPr }, realRun)) });
			return 0;
		}
		if (a.cmd === "gateway-pr") {
			result({ ok: true, ...(await gatewayPr(a.name, { title: a.title, body: a.body }, realRun)) });
			return 0;
		}
		const appsDir = process.env.THATSIT_APPS_DIR ?? join(homedir(), "workspace", "apps");
		if (a.cmd === "gateway-checkout") {
			result({ ok: true, ...(await gatewayCheckout(appsDir, realRun)) });
			return 0;
		}
		if (a.cmd === "gateway-register") {
			result({ ok: true, ...(await gatewayRegister(appsDir, a.name, realRun)) });
			return 0;
		}
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
