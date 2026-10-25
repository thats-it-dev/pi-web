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

// `cf pages list` is paginated, so look the project up by name instead.
export async function getPage(name: string, run: Run): Promise<{ name: string; subdomain: string } | null> {
	const args = ["pages", "get", name];
	const r = await run("cf", args);
	if (r.code === 0) return JSON.parse(r.stdout);
	if (/Project not found/i.test(r.stderr + r.stdout)) return null;
	throw fail("cf", args, r);
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
	if (await getPage(name, run)) return { ok: false, reason: `Pages project exists: ${name}` };
	if ((await dnsRecords(name, run)).length > 0) return { ok: false, reason: `DNS record exists: ${name}.${ZONE}` };
	return { ok: true };
}

// The spark gateway: private repo, tailnet-only. Preview for gateway PR #N is on port 9500+N (N 1-499).
export const GATEWAY_REPO = `${ORG}/spark-gateway`;
export const GATEWAY_HOST = "spark-713a.tail9274fa.ts.net";
export const MAX_GATEWAY_PR = 499;
export const gatewayPreviewUrl = (n: number) => `https://${GATEWAY_HOST}:${9500 + n}`;
