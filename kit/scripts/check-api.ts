import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ApiSurface, diffSurface } from "./surface.ts";

type FetchFn = (url: string) => Promise<Response>;

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** Compares the live `<url>/api.json` with the surface about to be deployed (default: dist/api.json). */
export async function checkApi(
	url: string,
	fetchFn: FetchFn = fetch,
	next?: ApiSurface,
): Promise<{ ok: boolean; message: string }> {
	const target = `${url.replace(/\/$/, "")}/api.json`;
	let res: Response;
	try {
		res = await fetchFn(target);
	} catch (err) {
		return { ok: false, message: `cannot reach ${target}: ${err instanceof Error ? err.message : err}` };
	}
	if (res.status === 404) return { ok: true, message: "no published surface; first deploy" };
	if (res.status !== 200) return { ok: false, message: `${target} answered ${res.status}` };
	let prev: ApiSurface;
	try {
		prev = (await res.json()) as ApiSurface;
	} catch {
		return { ok: false, message: `${target} is not valid JSON` };
	}
	const local = next ?? (JSON.parse(await readFile(join(distDir, "api.json"), "utf8")) as ApiSurface);
	const removed = diffSurface(prev, local);
	if (removed.length) return { ok: false, message: `API surface lost entries (additive-only):\n${removed.join("\n")}` };
	return { ok: true, message: "API surface is additive-only" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const url = process.argv[2];
	if (!url) {
		console.error("usage: check-api.ts <url>");
		process.exit(1);
	}
	const { ok, message } = await checkApi(url);
	(ok ? console.log : console.error)(message);
	process.exit(ok ? 0 : 1);
}
