import { fail, type Run } from "./run.ts";

export const ORG = "thats-it-dev";
export const ZONE = "thatsit.app";
// Same rule as the template's parseConfig.
export const NAME_RE = /^[a-z](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
export const RESERVED = ["pi", "kit", "www", "app", "api", "mail", "app-template"];

export type CheckResult = { ok: true } | { ok: false; reason: string };

export async function repoExists(name: string, run: Run): Promise<boolean> {
	const args = ["repo", "view", `${ORG}/${name}`, "--json", "name"];
	const r = await run("gh", args);
	if (r.code === 0) return true;
	// Only a clear "not found" counts as free; auth/network errors must not look like availability.
	if (/Could not resolve to a Repository/i.test(r.stderr)) return false;
	throw fail("gh", args, r);
}

export async function listPages(run: Run): Promise<{ name: string; subdomain: string }[]> {
	const r = await run("cf", ["pages", "list"]);
	if (r.code !== 0) throw fail("cf", ["pages", "list"], r);
	return JSON.parse(r.stdout);
}

export type DnsRecord = { name: string; type: string; content: string };

export async function dnsRecords(name: string, run: Run): Promise<DnsRecord[]> {
	const args = ["dns", "records", "list", "-z", ZONE, "--name", `${name}.${ZONE}`];
	const r = await run("cf", args);
	if (r.code !== 0) throw fail("cf", args, r);
	return JSON.parse(r.stdout);
}

export async function checkName(name: string, run: Run): Promise<CheckResult> {
	if (!NAME_RE.test(name)) return { ok: false, reason: `invalid name "${name}": use 1-30 lowercase letters, digits or hyphens, starting with a letter` };
	if (RESERVED.includes(name)) return { ok: false, reason: `reserved name "${name}"` };
	if (await repoExists(name, run)) return { ok: false, reason: `GitHub repo exists: ${ORG}/${name}` };
	if ((await listPages(run)).some((p) => p.name === name)) return { ok: false, reason: `Pages project exists: ${name}` };
	if ((await dnsRecords(name, run)).length > 0) return { ok: false, reason: `DNS record exists: ${name}.${ZONE}` };
	return { ok: true };
}
