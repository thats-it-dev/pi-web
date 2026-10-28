// The Pebble watch's HTTP surface (spec §5): /api/watch/*. The caller has already
// authenticated the request; these routes send no CORS headers.

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./errors.ts";
import { readJson, sendJson } from "./http.ts";
import type { WatchService } from "./watch.ts";
import { launchOnPhone, UUID_RE } from "./watch-launch.ts";

export interface WatchRouteDeps {
	watch: WatchService;
	version: string;
	launchFn?: typeof launchOnPhone;
	launchTarget?: (code: number) => { queryId: string } | { sessionId: string } | null;
	log?: (m: string) => void;
}

const WAIT_MS = 25_000;
const HISTORY_DEFAULT = 12;
const HISTORY_MAX = 50;

const str = (v: unknown): v is string => typeof v === "string" && v !== "";

export async function routeWatch(req: IncomingMessage, res: ServerResponse, url: URL, deps: WatchRouteDeps): Promise<boolean> {
	const { watch } = deps;
	const p = url.pathname;
	const m = req.method;
	const q = url.searchParams;
	const reply = (body: unknown) => sendJson(res, 200, body, {});

	if (m === "GET") {
		if (p === "/api/watch/pending") {
			const since = Number(q.get("since"));
			if (q.get("wait") !== "1") return reply(watch.pending()), true;
			// The waiter leaves the service's set the moment the client goes.
			const gone = new AbortController();
			const onClose = () => gone.abort();
			res.on("close", onClose);
			try {
				const pending = await watch.wait(Number.isFinite(since) ? since : 0, WAIT_MS, gone.signal);
				if (!gone.signal.aborted) reply(pending);
			} finally {
				res.off("close", onClose);
			}
			return true;
		}
		if (p === "/api/watch/sessions") return reply({ sessions: await watch.sessions() }), true;
		if (p === "/api/watch/history") {
			const session = q.get("session");
			if (!session) throw new HttpError(400, "A session is required");
			const limit = Number(q.get("limit"));
			const before = q.get("before");
			const b = before === null || before === "" ? NaN : Number(before);
			const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, HISTORY_MAX) : HISTORY_DEFAULT;
			return reply(await watch.history(session, Number.isInteger(b) ? b : undefined, n)), true;
		}
		if (p === "/api/watch/models") {
			const session = q.get("session");
			if (!session) throw new HttpError(400, "A session is required");
			return reply(await watch.models(session)), true;
		}
		if (p === "/api/watch/launch-target") {
			const raw = q.get("code");
			const code = raw !== null && /^\d{1,10}$/.test(raw) ? Number(raw) : NaN;
			if (!Number.isInteger(code) || code > 0xffffffff) throw new HttpError(400, "A code is required");
			const target = deps.launchTarget?.(code);
			if (!target) throw new HttpError(404, "No such launch target");
			return reply(target), true;
		}
		if (p === "/api/watch/health") return reply({ ok: true, hubVersion: deps.version, sessions: watch.health() }), true;
		return false;
	}

	if (m === "POST") {
		const known = ["showing", "answer", "skip", "prompt", "model", "launch", "abort", "archive", "new"].map((a) => `/api/watch/${a}`);
		if (!known.includes(p)) return false;
		const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
		if (p === "/api/watch/showing") {
			const { queryId, sessionId } = body;
			if (queryId !== null && !str(queryId)) throw new HttpError(400, "queryId must be a string or null");
			if (sessionId !== undefined && sessionId !== null && !str(sessionId)) throw new HttpError(400, "sessionId must be a string or null");
			watch.showing({ queryId, sessionId: sessionId ?? null });
			return reply({ ok: true }), true;
		}
		if (p === "/api/watch/answer") {
			const { queryId, option, text } = body;
			if (!str(queryId)) throw new HttpError(400, "A queryId is required");
			if ((option === undefined) === (text === undefined)) throw new HttpError(400, "Send exactly one of option or text");
			if ((option !== undefined && typeof option !== "string") || (text !== undefined && typeof text !== "string")) throw new HttpError(400, "option and text must be strings");
			return reply(await watch.answer(queryId, { option, text })), true;
		}
		if (p === "/api/watch/skip") {
			if (!str(body.queryId)) throw new HttpError(400, "A queryId is required");
			watch.skip(body.queryId);
			return reply({ ok: true }), true;
		}
		if (p === "/api/watch/launch") {
			const { uuid } = body;
			if (typeof uuid !== "string" || !UUID_RE.test(uuid)) throw new HttpError(400, "A uuid is required");
			if (watch.phone === null) {
				deps.log?.(`watch: launch ${uuid}: no phone`);
				return reply({ ok: false, reason: "no_phone" }), true;
			}
			const r = await (deps.launchFn ?? launchOnPhone)(watch.phone, uuid);
			deps.log?.(`watch: launch ${uuid} on ${watch.phone}: ${r.ok ? "ok" : r.reason}`);
			return reply(r), true;
		}
		if (p === "/api/watch/prompt") {
			if (!str(body.sessionId) || typeof body.text !== "string") throw new HttpError(400, "A sessionId and text are required");
			return reply(await watch.prompt(body.sessionId, body.text)), true;
		}
		if (p === "/api/watch/abort") {
			if (!str(body.sessionId)) throw new HttpError(400, "A sessionId is required");
			return reply(await watch.abort(body.sessionId)), true;
		}
		if (p === "/api/watch/new") return reply({ ok: true, sessionId: await watch.newSession() }), true;
		if (p === "/api/watch/archive") {
			if (!str(body.sessionId)) throw new HttpError(400, "A sessionId is required");
			watch.archive(body.sessionId);
			return reply({ ok: true }), true;
		}
		if (!str(body.sessionId) || !str(body.provider) || !str(body.modelId)) throw new HttpError(400, "A sessionId, provider and modelId are required");
		await watch.setModel(body.sessionId, body.provider, body.modelId);
		return reply({ ok: true }), true;
	}
	return false;
}

