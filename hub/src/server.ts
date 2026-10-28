// HTTP API for the PWA (spec §2.3). Every request passes checkRequest except
// CORS preflights from an allowed origin. Streams are Server-Sent Events.

import { createReadStream, existsSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { APPROVAL_MODES, APP_COMMAND_TYPES, type AppCommand, type DefaultsInfo, type HealthInfo, type ThinkingLevel, type ListMessage, type SessionSummary, type StreamMessage, type UpdateResult } from "../../shared/src/protocol.ts";
import { checkHostAndLogin, checkRequest, corsHeaders } from "./auth.ts";
import type { HubConfig } from "./config.ts";
import type { LastModelStore, ModelChoice } from "./last-model.ts";
import { type Catalog, type ModelCatalog, modelKey, resolveChoice } from "./model-catalog.ts";
import { ImageStore } from "./images.ts";
import { HttpError } from "./errors.ts";
import { FileLister } from "./files.ts";
import { ReplayCache, handleIndexWebhook } from "./index-webhook.ts";
import type { Outbox } from "./notes-outbox.ts";
import { handleNotesWebhook } from "./notes-webhook.ts";
import { type Cors, readJson, sendJson } from "./http.ts";
import type { SessionHandle } from "./handle.ts";
import type { Registry } from "./registry.ts";
import { type PushStore, isSubscription } from "./push.ts";
import type { Viewers } from "./push-watch.ts";
import { type SessionIndex, knownCwds, readHistory } from "./sessions.ts";
import type { Updater } from "./update.ts";
import type { WatchService } from "./watch.ts";
import type { launchOnPhone } from "./watch-launch.ts";
import { routeWatch } from "./watch-routes.ts";

export interface HubDeps {
	cfg: HubConfig;
	registry: Registry;
	index: SessionIndex;
	version: string;
	home?: string;
	log?: (msg: string) => void;
	push?: PushStore;
	viewers?: Viewers; // open apps; holds back push while there are any
	updater?: Updater; // self-update from the app (update.ts); absent means the routes answer 501
	restart?: () => void; // after a successful update; the default exits so systemd restarts the unit
	watch?: WatchService; // the Pebble watch API; absent means /api/watch/* answers 503
	images?: ImageStore; // image bytes by ref; absent means a private store
	launchFn?: typeof launchOnPhone; // watch launch relay; tests stub it
	launchTarget?: (code: number) => { queryId: string } | { sessionId: string } | null; // what a notification's launch code meant (Notifier)
	catalog?: Pick<ModelCatalog, "get">; // models for /api/defaults and new sessions; absent means none known
	lastModel?: LastModelStore; // the last model picked in pi-web; absent means none remembered
	notesOutbox?: Outbox; // forwards ring notes to ring-profile; absent (ringProfileUrl "") means notes are only stored
	now?: () => number;
}

const SSE_PING_MS = 20_000;
const FILE_RESULTS = 20;

export function createHubServer(deps: HubDeps): Server {
	const home = deps.home ?? homedir();
	const log = deps.log ?? ((m: string) => console.log(m));
	const { cfg, registry, index } = deps;
	const fileLister = new FileLister();
	const replays = new ReplayCache();
	const images = deps.images ?? new ImageStore();
	const catalog = deps.catalog ?? { get: async (): Promise<Catalog> => ({ models: [], piDefault: null, levels: {} }) };

	async function route(req: IncomingMessage, res: ServerResponse, cors: Cors): Promise<void> {
		const { pathname: p, searchParams } = new URL(req.url ?? "/", "http://hub");
		const m = req.method;

		if (m === "GET" && p === "/api/health") {
			const body: HealthInfo = { ok: true, login: String(req.headers["tailscale-user-login"]), hubVersion: deps.version, vapidPublicKey: deps.push?.publicKey ?? null };
			return sendJson(res, 200, body, cors);
		}
		if (p === "/api/update") {
			if (!deps.updater) throw new HttpError(501, "This hub can't update itself.");
			if (m === "GET") return sendJson(res, 200, await deps.updater.status(), cors);
			if (m === "POST") {
				const body = (await readJson(req)) as { force?: unknown };
				const busy = registry.all().filter((h) => h.isBusy()).length;
				if (busy && body.force !== true) throw new HttpError(409, `${busy} session${busy === 1 ? " is" : "s are"} mid-turn; updating now would cut ${busy === 1 ? "it" : "them"} off.`);
				const status = await deps.updater.status();
				if (status.dirty) throw new HttpError(409, "The hub's checkout has local changes; pull by hand first.");
				log("updating: git pull + npm install");
				const r = await deps.updater.apply();
				log(`updated to ${r.commit}; restarting`);
				const out: UpdateResult = { ok: true, commit: r.commit, output: r.output, restarting: true };
				sendJson(res, 200, out, cors);
				setTimeout(() => (deps.restart ?? (() => process.exit(0)))(), 300).unref();
				return;
			}
		}
		if (m === "GET" && p === "/api/sessions") return sendJson(res, 200, { sessions: await listSessions(), home }, cors);
		if (m === "GET" && p === "/api/cwds") return sendJson(res, 200, { cwds: knownCwds(await index.list(), home), home }, cors);
		if (m === "GET" && p === "/api/events") return listStream(req, res, cors);
		if (m === "GET" && p === "/api/defaults") {
			const cat = await catalog.get();
			const model = resolveChoice(cat, deps.lastModel?.get() ?? null);
			const thinkingLevels = model ? (cat.levels[modelKey(model.provider, model.modelId)] ?? []) : [];
			const body: DefaultsInfo = { models: cat.models, model, thinkingLevels, levels: cat.levels, approvalMode: cfg.approvalMode, home };
			return sendJson(res, 200, body, cors);
		}
		if (m === "POST" && p === "/api/sessions") {
			const body = (await readJson(req)) as { cwd?: unknown; model?: unknown; thinking?: unknown };
			// Relative folders are relative to home, not to wherever the hub was started.
			const raw = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : "~";
			const cwd = resolve(home, raw.replace(/^~(?=\/|$)/, home));
			if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new HttpError(400, `Not a folder: ${cwd}`);
			const wanted = parseModel(body);
			const cat = await catalog.get();
			const fallback = resolveChoice(cat, deps.lastModel?.get() ?? null);
			// No catalog (the probe failed): pi gets what the app sent, and judges it itself.
			if (!cat.models.length) {
				const h = await registry.create(cwd, wanted);
				return sendJson(res, 200, { sessionId: h.sessionId }, cors);
			}
			if (wanted && !cat.models.some((x) => x.provider === wanted.provider && x.id === wanted.modelId)) throw new HttpError(400, `Unknown model: ${wanted.provider}/${wanted.modelId}`);
			const choice = wanted ? resolveChoice(cat, wanted) : fallback;
			const h = await registry.create(cwd, choice);
			// Only a real pick is remembered: sending the default as-is leaves pi's own default free to change.
			if (choice && !sameChoice(choice, fallback)) {
				try {
					deps.lastModel?.set(choice);
				} catch (err) {
					log(`couldn't save the last model: ${(err as Error).message}`);
				}
			}
			return sendJson(res, 200, { sessionId: h.sessionId }, cors);
		}
		if (m === "POST" && (p === "/api/push/subscribe" || p === "/api/push/unsubscribe")) {
			if (!deps.push) throw new HttpError(503, "Push isn't set up on this hub");
			const body = await readJson(req);
			if (p === "/api/push/subscribe") {
				if (!isSubscription(body)) throw new HttpError(400, "Not a push subscription");
				deps.push.subscribe(body);
			} else {
				const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
				if (typeof endpoint !== "string") throw new HttpError(400, "An endpoint is required");
				deps.push.unsubscribe(endpoint);
			}
			return sendJson(res, 200, { ok: true }, cors);
		}

		const im = p.match(/^\/api\/sessions\/([\w.-]+)\/images\/([0-9a-f]{64})$/);
		if (m === "GET" && im) {
			const [, id, ref] = im;
			let img = images.has(id, ref) ? images.get(id, ref) : undefined;
			// Unknown ref, or its bytes were evicted: look for just that image in the session.
			if (!img) {
				const live = registry.get(id);
				const found = live ? live.snapshot().conv.messages : await index.find(id).then((s) => (s ? readHistory(s.file) : []));
				img = images.find(id, ref, found);
			}
			if (!img) throw new HttpError(404, "Image not found");
			res.writeHead(200, { ...cors, "content-type": img.mimeType, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-length": img.bytes.length });
			res.end(img.bytes);
			return;
		}

		const sm = p.match(/^\/api\/sessions\/([\w.-]+)\/(history|stream|commands|close|files)$/);
		if (sm) {
			const [, id, action] = sm;
			if (m === "GET" && action === "history") return sendJson(res, 200, await history(id), cors);
			if (m === "GET" && action === "stream") return sessionStream(req, res, cors, id);
			if (m === "GET" && action === "files") {
				const cwd = registry.get(id)?.cwd ?? (await index.find(id))?.cwd;
				if (!cwd) throw new HttpError(404, "Session not found");
				return sendJson(res, 200, { files: await fileLister.search(cwd, searchParams.get("q") ?? "", FILE_RESULTS) }, cors);
			}
			if (m === "POST" && action === "commands") {
				const cmd = parseCommand(await readJson(req));
				const h = await registry.ensure(id);
				const result = await h.command(cmd);
				return sendJson(res, 200, { result: images.outgoing(h.sessionId, result), sessionId: h.sessionId }, cors);
			}
			if (m === "POST" && action === "close") {
				registry.close(id);
				return sendJson(res, 200, { ok: true }, cors);
			}
		}

		const ex = p.match(/^\/api\/exports\/([\w.-]+\.html)$/);
		if (m === "GET" && ex) {
			const file = join(cfg.dataDir, "exports", ex[1]);
		if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "Export not found");
		await new Promise<void>((resolve) => {
			const stream = createReadStream(file);
			// Headers go out only once the file opened, so an unreadable file can still get a clean 500.
			stream.once("open", () => {
				res.writeHead(200, { ...cors, "content-type": "text/html; charset=utf-8", "content-disposition": `attachment; filename="${ex[1]}"` });
				stream.pipe(res);
			});
			stream.on("error", (err) => {
				log(`error reading export ${file}: ${err.message}`);
				if (!res.headersSent) sendJson(res, 500, { error: "Could not read export" }, cors);
				else res.destroy();
				resolve();
			});
			res.on("close", () => {
				stream.destroy();
				resolve();
			});
		});
			return;
		}
		throw new HttpError(404, "Not found");
	}

	async function listSessions(): Promise<SessionSummary[]> {
		const files = await index.list();
		const known = new Set(files.map((f) => f.id));
		const now = Date.now();
		// A brand-new session has no file until its first message.
		const fresh = registry
			.all()
			.filter((h) => h.sessionId && !known.has(h.sessionId))
			.map((h) => ({ id: h.sessionId, cwd: h.cwd, name: h.snapshot().state?.sessionName ?? null, firstPrompt: null, userMessages: 0, model: null, contextTokens: null, createdAt: now, updatedAt: now, parentSession: null }));
		const onDisk = files.map(({ file: _file, ...s }) => s);
		return [...fresh, ...onDisk].map((s) => ({ ...s, ...registry.info(s.id) }));
	}

	async function history(id: string) {
		const h = registry.get(id);
		if (h) return { messages: images.outgoing(id, h.snapshot().conv.messages), live: true, cwd: h.cwd };
		const s = await index.find(id);
		if (!s) throw new HttpError(404, "Session not found");
		return { messages: images.outgoing(id, await readHistory(s.file)), live: false, cwd: s.cwd, name: s.name, error: registry.lastError(id) ?? null };
	}

	function sessionStream(req: IncomingMessage, res: ServerResponse, cors: Cors, sessionId: string): void {
		const sse = openSse(res, cors);
		let id = sessionId;
		let detach: (() => void) | null = null;
		const attach = (h: SessionHandle) => {
			detach?.();
			const unsubscribe = h.subscribe((msg) => {
				if (msg.type === "snapshot") id = msg.snapshot.sessionId; // follows fork/clone/new
				sse.send(images.outgoing(id, msg));
				if (msg.type === "handle_gone") {
					unsubscribe();
					detach = null;
					sse.send({ type: "detached" });
					// Another handle may already hold the session (a terminal took over before this one exited).
					const next = registry.get(id);
					if (next && next !== h) attach(next);
				}
			});
			detach = unsubscribe;
			sse.send(images.outgoing(id, { type: "snapshot", snapshot: h.snapshot() }));
		};
		const existing = registry.get(id);
		if (existing) attach(existing);
		else sse.send({ type: "detached" });
		const stopWatching = registry.onChange((m) => {
			if (detach || m.type !== "session_state" || m.sessionId !== id || !m.live) return;
			const h = registry.get(id);
			if (h) attach(h);
		});
		req.on("close", () => {
			detach?.();
			stopWatching();
			sse.close();
		});
	}

	function listStream(req: IncomingMessage, res: ServerResponse, cors: Cors): void {
		const sse = openSse(res, cors);
		const stop = registry.onChange((m) => sse.send(m));
		const leave = deps.viewers?.add();
		req.on("close", () => {
			stop();
			leave?.();
			sse.close();
		});
	}

	return createServer(async (req, res) => {
		const cors = corsHeaders(cfg, req.headers.origin);
		try {
			if (req.method === "OPTIONS") {
				if (!cors["access-control-allow-origin"]) throw new HttpError(403, "Forbidden");
				res.writeHead(204, cors);
				res.end();
				return;
			}
			const path = new URL(req.url ?? "/", "http://hub").pathname;
			if (path.startsWith("/api/watch/")) {
				// The watch has no Origin; the tailnet identity alone lets it in (auth.ts).
				// Identity first, so a stranger can't tell whether the watch API is configured.
				const identity = checkHostAndLogin(cfg, req.headers);
				if (!identity.ok) {
					log(`rejected ${req.method} ${req.url}: ${identity.reason}`);
					throw new HttpError(403, "Forbidden");
				}
				if (!deps.watch) throw new HttpError(503, "Watch API isn't set up on this hub");
				deps.watch.notePhone(req.headers, req.socket.remoteAddress);
				const url = new URL(req.url ?? "/", "http://hub");
				if (!(await routeWatch(req, res, url, { watch: deps.watch, version: deps.version, launchFn: deps.launchFn, launchTarget: deps.launchTarget, log }))) throw new HttpError(404, "Not found");
				return;
			}
			if (req.method === "POST" && path === "/api/index/webhook") {
				// The ring has no Origin either; same rule as the watch routes.
				const identity = checkHostAndLogin(cfg, req.headers);
				if (!identity.ok) {
					log(`rejected ${req.method} ${req.url}: ${identity.reason}`);
					throw new HttpError(403, "Forbidden");
				}
				if (!deps.watch) throw new HttpError(503, "Watch API isn't set up on this hub");
				await handleIndexWebhook(req, res, { watch: deps.watch, dataDir: cfg.dataDir, replays, now: deps.now, log });
				return;
			}
			if (req.method === "POST" && path === "/api/index/notes") {
				// The ring's notes webhook: same identity rule; it never touches pi, so no watch is needed.
				const identity = checkHostAndLogin(cfg, req.headers);
				if (!identity.ok) {
					log(`rejected ${req.method} ${req.url}: ${identity.reason}`);
					throw new HttpError(403, "Forbidden");
				}
				await handleNotesWebhook(req, res, { dataDir: cfg.dataDir, replays, outbox: deps.notesOutbox, now: deps.now, log });
				return;
			}
			const auth = checkRequest(cfg, req.headers);
			if (!auth.ok) {
				log(`rejected ${req.method} ${req.url}: ${auth.reason}`);
				throw new HttpError(403, "Forbidden");
			}
			await route(req, res, cors);
		} catch (err) {
			const status = err instanceof HttpError ? err.status : 500;
			if (status === 500) log(`error ${req.method} ${req.url}: ${(err as Error).stack}`);
			if (!res.headersSent) sendJson(res, status, { error: (err as Error).message }, cors);
			else res.end();
		}
	});
}

function openSse(res: ServerResponse, cors: Cors) {
	res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
	res.write(": connected\n\n");
	const ping = setInterval(() => res.write(": ping\n\n"), SSE_PING_MS);
	return {
		send(m: StreamMessage | ListMessage) {
			res.write(`data: ${JSON.stringify(m)}\n\n`);
		},
		close() {
			clearInterval(ping);
		},
	};
}

// The draft's model for a new session; its thinking level is checked against the model later (resolveChoice).
const sameChoice = (a: ModelChoice, b: ModelChoice | null) => a.provider === b?.provider && a.modelId === b.modelId && a.thinking === b.thinking;

function parseModel(body: { model?: unknown; thinking?: unknown }): ModelChoice | null {
	if (body.model == null) return null;
	const { provider, modelId } = body.model as { provider?: unknown; modelId?: unknown };
	if (typeof provider !== "string" || typeof modelId !== "string") throw new HttpError(400, "A model needs a provider and a modelId");
	return { provider, modelId, thinking: typeof body.thinking === "string" ? (body.thinking as ThinkingLevel) : null };
}

function parseCommand(body: unknown): AppCommand {
	const type = (body as { type?: unknown } | null)?.type;
	if (typeof type !== "string" || !(APP_COMMAND_TYPES as readonly string[]).includes(type)) throw new HttpError(400, `Unknown command: ${String(type)}`);
	const cmd = body as AppCommand;
	if (cmd.type === "prompt" && typeof cmd.text !== "string") throw new HttpError(400, "A prompt needs text");
	if (cmd.type === "set_approval" && !APPROVAL_MODES.includes(cmd.mode)) throw new HttpError(400, `Approval mode must be one of ${APPROVAL_MODES.join(", ")}`);
	return cmd;
}
