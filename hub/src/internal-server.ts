// Loopback-only API for services on this machine (ring-profile) to put questions to the watch.
// It is a separate listener on 127.0.0.1, never a route on the public server: that one is reached
// through `tailscale serve` from localhost and trusts Tailscale identity headers, so anything
// mounted there would be open to the tailnet.

import http from "node:http";
import type { QueryOutcome } from "../../shared/src/protocol.ts";
import { HttpError } from "./errors.ts";
import { readJson, sendJson } from "./http.ts";
import type { QueryStore } from "./queries.ts";

export interface InternalDeps {
	store: QueryStore;
	fetchFn?: typeof fetch;
	log?: (m: string) => void;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 3_600_000;
const CALLBACK_TIMEOUT_MS = 5000;

function str(v: unknown, name: string): string {
	if (typeof v !== "string" || !v) throw new HttpError(400, `${name} must be a non-empty string`);
	return v;
}

function httpUrl(v: unknown): string {
	const s = str(v, "callbackUrl");
	let ok = false;
	try {
		ok = /^https?:$/.test(new URL(s).protocol);
	} catch {}
	if (!ok) throw new HttpError(400, "callbackUrl must be an http(s) URL");
	return s;
}

export function createInternalServer(deps: InternalDeps): http.Server {
	const { store } = deps;
	const fetchFn = deps.fetchFn ?? fetch;
	const log = deps.log ?? (() => {});

	// One attempt, never retried; called from QueryStore's onOutcome so it must not throw or block.
	function callback(url: string, id: string, outcome: QueryOutcome): void {
		fetchFn(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id, outcome }),
			signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
		})
			.then((res) => {
				if (!res.ok) log(`query ${id}: callback answered ${res.status}`);
			})
			.catch((err) => log(`query ${id}: callback failed: ${(err as Error).message}`));
	}

	async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		if (req.method === "GET" && path === "/queries") return sendJson(res, 200, { queries: store.external() }, {});
		if (req.method === "POST" && path === "/queries") {
			const b = (await readJson(req)) as Record<string, unknown>;
			const label = str(b.label, "label");
			const text = str(b.text, "text");
			if (!Array.isArray(b.options) || !b.options.every((o) => typeof o === "string")) throw new HttpError(400, "options must be an array of strings");
			const callbackUrl = httpUrl(b.callbackUrl);
			const timeoutMs = b.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			if (typeof timeoutMs !== "number" || !(timeoutMs > 0) || timeoutMs > MAX_TIMEOUT_MS) throw new HttpError(400, `timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
			const q = store.raise({
				source: "ring-profile",
				label,
				text,
				options: b.options as string[],
				timeoutMs,
				onOutcome: (o) => callback(callbackUrl, q.id, o),
			});
			return sendJson(res, 201, { id: q.id }, {});
		}
		const m = req.method === "POST" ? /^\/queries\/([^/]+)\/clear-by-ring$/.exec(path) : null;
		if (m) {
			const text = str(((await readJson(req)) as Record<string, unknown>).text, "text");
			if (!store.resolve(decodeURIComponent(m[1]), { kind: "cleared-by-ring", text })) throw new HttpError(404, "No such query");
			return sendJson(res, 200, { ok: true }, {});
		}
		throw new HttpError(404, "Not found");
	}

	return http.createServer((req, res) => {
		handle(req, res).catch((err) => {
			if (err instanceof HttpError) sendJson(res, err.status, { error: err.message }, {});
			else {
				log(`internal server: ${(err as Error).message}`);
				sendJson(res, 500, { error: "Internal error" }, {});
			}
		});
	});
}
