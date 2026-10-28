// A stand-in hub for the emulator: canned watch data in the query protocol
// (shared/src/protocol.ts WatchPending), no auth.
// Run from the repo root (ws resolves from the root node_modules):
//   node watch/app/dev/stub-hub.mjs --port 5173 [--scene default|all|empty|ring|many] [--dark 0|1] [--delay ms]
// Scenes: default = three sessions (waiting, running, done) and a pi query on the waiting one;
// all = the same plus a session in error; empty = no sessions, no queries;
// ring = the default plus a ring-profile query; many = twenty sessions with
// ~40-char titles and ~600-char replies (the phone sends twelve, its row limit,
// so an archived row is replaced by the next one, as on the real hub; Home's memory).
// POST /stub/notice {text} sends a notice frame; POST /stub/query {text?, options?, source?} raises a query;
// POST /stub/dark {dark: 0|1} changes what /dev/settings reports (the phone reads it at start).
// POST /stub/stream {sessionId?, ms?, count?} streams a reply like the real hub: the session runs,
// a `text` frame (streaming, the last 240 chars of a growing reply) goes out every ms (250), a
// pending frame once a second, then a final text frame and the session is done; its history
// then ends with the streamed reply. sessionId defaults to the one on screen; a second stream on
// a session replaces the first. The phone relays no streamed text: the watch shows a typing
// indicator while the session runs and gets the reply from the history when the run ends.
// POST /api/watch/new (Home's "+ New session") adds an empty session "pebble" (id n1, n2, …) whose
// history has no turns until it is prompted. POST /stub/ring {text} stands in for a ring note and
// routes it as the hub does (spec §5): it answers the query on screen, else prompts the session on
// screen (which then streams a short reply), else, with the app closed (no stream or poll for 45 s),
// answers the oldest pi query that has options (one with none stands for an input dialog, never
// answered); the alert the hub would send, a miss or a receipt, is logged. Else a new session.
// The stub doesn't model recordedAt or which queries were alerted.
import http from "node:http";
import { WebSocketServer } from "ws";

// --- Fixtures ---------------------------------------------------------------

const NOW = Date.now();
const MIN = 60 * 1000;

const session = (id, title, status, ago) => ({
	id,
	title,
	state: { waiting: "needs_you", running: "running", done: "idle", error: "error" }[status],
	status,
	live: status !== "done",
	model: "qwen3",
	contextPercent: 41,
	contextTokens: 53700,
	contextWindow: 131072,
	tps: status === "running" ? 62 : null,
	updatedAt: NOW - ago * MIN,
});

const SESSIONS = [
	session("s1", "notesky sync", "waiting", 2),
	session("s2", "pi-web watch", "running", 1),
	session("s3", "flash-auto", "done", 20),
];
const ERRORED = session("s4", "tips site", "error", 110);

const PI_QUERY = {
	id: "q1",
	source: "pi",
	sessionId: "s1",
	label: "pi · notesky sync",
	text: "Allow bash?\ngit push origin main",
	options: ["Allow", "Always allow", "Deny"],
	createdAt: NOW - 2 * MIN,
};
const RING_QUERY = {
	id: "q2",
	source: "ring-profile",
	sessionId: null,
	label: "ring · follow-up",
	text: "You mentioned the dentist twice this week. Should I add a reminder for Thursday?",
	options: ["Yes", "No", "Later"],
	createdAt: NOW - 1 * MIN,
};

const REPLIES = {
	s1: "Synced 14 notes. One conflict in daily/2026-10-27.md; I need to push the merge.",
	s2: "Rendering the session list with pebble-ui Menu. Status dots are drawn as 10 px circles. Next: the query screen and its action menu.",
	s3: "Benchmark finished. flash-auto picked low reasoning on 71% of turns; accuracy within 1 point of always-high. Report is in reports/2026-10-27.md.",
	s4: "Deploy failed: wrangler pages deploy exited 1 (auth token expired). Run cf auth login on the spark, then retry.",
};

// many: twenty sessions, titles near the bridge's 40-char clip. The bridge sends the first
// twelve (HOME_ROWS); the rest refill the list when one is archived, as the hub's closed sessions do.
const MANY_TITLES = [
	"notesky sync: merge daily notes conflicts",
	"pi-web watch: Home rows as a single port",
	"flash-auto router benchmark, low vs high",
	"tips.thatsit.app deploy via the gateway",
	"llama-swap config reload for the 27b model",
	"pebble-ui action menu long-press repeat",
	"atproto-sync cron and llmwiki pipeline",
	"ring-profile follow-ups for the calendar",
	"ui-patterns-alloy status bar separators",
	"spark sglang backend memory regression",
	"pi-web chat app plus menu and model pick",
	"fitsky patterns dashboard card layouts",
	"hub watch alerts: notification vs push",
	"pebble phone dev-connection over tailnet",
	"llmwiki: nightly digest of notesky notes",
	"thatsit.app kit template and deploy skill",
	"pi-web images in replies by reference",
	"ui-patterns-alloy menu inset regression",
	"flash-auto: private benchmark backups",
	"pebble-ui PIN window long-press repeat",
];
const MANY_STATUS = ["waiting", "running", "done", "error", "running", "done", "done", "running", "done", "done", "running", "done",
	"done", "done", "done", "done", "done", "done", "done", "done"];
const MANY = MANY_TITLES.map((title, i) => session("m" + (i + 1), title, MANY_STATUS[i], i * 7 + 1));
const MANY_QUERY = { ...PI_QUERY, sessionId: "m1", label: "pi · notesky sync: merge daily…" };
const LONG_REPLY = (title) =>
	`Finished the pass on ${title}. I read watch/app/src/embeddedjs/windows/home.js and ~/workspace/pebble-ui/modules/Menu.js, ` +
	"then changed the row template so each session is drawn by one port instead of two labels and a dot. The full path of the " +
	"file I touched is /home/michael/workspace/pi-web-watch-ui/watch/app/src/embeddedjs/windows/home.js and the stub scene lives " +
	"in watch/app/dev/stub-hub.mjs. Tests pass (node --test watch/app/test/), the build is under the emulator ceiling, and the " +
	"screenshots match the previous ones in light and dark. Next I will scroll this reply to its end to check the text window.";

const MODELS = [
	{ provider: "spark", id: "qwen3-30b-a3b", name: "Qwen3 30B A3B" },
	{ provider: "spark", id: "gpt-oss-120b", name: "gpt-oss 120B" },
	{ provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
];

// --- Args -------------------------------------------------------------------

function arg(name, fallback) {
	const i = process.argv.indexOf("--" + name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = Number(arg("port", "5173"));
const SCENE = arg("scene", "default");
let DARK = Number(arg("dark", "0")) ? 1 : 0;
const DELAY = Number(arg("delay", "0")) || 0;
const SCENES = {
	default: () => [SESSIONS, [PI_QUERY]],
	all: () => [[...SESSIONS, ERRORED], [PI_QUERY]],
	empty: () => [[], []],
	ring: () => [SESSIONS, [PI_QUERY, RING_QUERY]],
	many: () => [MANY, [MANY_QUERY]],
};
if (!SCENES[SCENE]) {
	console.error(`unknown scene ${SCENE}; use ${Object.keys(SCENES).join(", ")}`);
	process.exit(2);
}

// --- State ------------------------------------------------------------------

let [sessions, queries] = SCENES[SCENE]().map((list) => list.map((x) => ({ ...x })));
let cursor = 1;
let showing = null;
let lastAppAt = -Infinity; // when the app's stream or poll last left: it counts as open for APP_GRACE_MS more
const APP_GRACE_MS = 45_000;
let nextQuery = 3;
let nextNew = 1;
const fresh = new Set(); // sessions from /api/watch/new not prompted yet: no turns
const prompts = new Map(); // session id -> its last prompt, the "you" turn of its history
const waiters = new Set();
const sockets = new Set();
const streams = new Map(); // session id -> interval timer
const streamed = new Map(); // session id -> its last streamed reply, what its history then ends with

const pendingNow = () => ({ cursor, queries, showing, sessions });

function broadcast(frame) {
	for (const ws of sockets) ws.send(JSON.stringify(frame));
}

function changed() {
	cursor++;
	const p = pendingNow();
	if (waiters.size) lastAppAt = Date.now();
	for (const w of waiters) w(p);
	waiters.clear();
	broadcast({ type: "pending", ...p });
}

// A session with no query left stops waiting and runs.
function removeQuery(id) {
	const q = queries.find((x) => x.id === id);
	if (!q) return false;
	queries = queries.filter((x) => x.id !== id);
	const s = q.sessionId && sessions.find((x) => x.id === q.sessionId);
	if (s && !queries.some((x) => x.sessionId === s.id)) Object.assign(s, { status: "running", state: "running", updatedAt: Date.now() });
	changed();
	return true;
}

// --- Streaming --------------------------------------------------------------

const STREAM_WORDS = ("Reading the session list, then the text window. Each frame adds a few words, " +
	"as a model would, so the tail moves the way a real reply does on the watch: ").split(" ");
const TEXT_TAIL = 240; // as the hub's watch.ts

function startStream(s, ms, count) {
	clearInterval(streams.get(s.id));
	Object.assign(s, { status: "running", state: "running", updatedAt: Date.now() });
	changed();
	let text = "";
	let n = 0;
	let tickAt = Date.now();
	const timer = setInterval(() => {
		n++;
		text += " " + STREAM_WORDS[n % STREAM_WORDS.length] + " " + n;
		const last = n >= count;
		broadcast({ type: "text", sessionId: s.id, text: text.trim().slice(-TEXT_TAIL), streaming: !last });
		if (last) {
			clearInterval(timer);
			streams.delete(s.id);
			streamed.set(s.id, text.trim());
			Object.assign(s, { status: "done", state: "idle", updatedAt: Date.now() });
			changed();
			console.log(`stream ${s.id}: ${n} frames, done`);
		} else if (Date.now() - tickAt >= 1000) {
			// The hub wakes pollers about once a second while streaming (t/s moves).
			tickAt = Date.now();
			s.updatedAt = tickAt;
			changed();
		}
	}, ms);
	streams.set(s.id, timer);
	console.log(`stream ${s.id}: ${count} frames every ${ms} ms`);
}

// --- New sessions and ring notes --------------------------------------------

// An empty session in ~/pebble, titled after its folder as the hub's are.
function newSession() {
	const s = { ...session("n" + nextNew++, "pebble", "done", 0), updatedAt: Date.now() };
	sessions = [s, ...sessions];
	fresh.add(s.id);
	changed();
	return s;
}

// A prompt runs the session. A new session's first prompt becomes its title and it
// streams a short reply (/stub/stream); others just run, as before.
function prompt(s, text) {
	prompts.set(s.id, text);
	if (fresh.delete(s.id)) {
		s.title = text.slice(0, 40);
		startStream(s, 250, 12);
	} else {
		Object.assign(s, { status: "running", state: "running", updatedAt: Date.now() });
		changed();
	}
}

// Spec §5, as hub/src/index-webhook.ts decide(): the query on screen, else the session on screen,
// else (app closed) the oldest pi query, else a new session.
function ring(text) {
	const closed = sockets.size + waiters.size === 0 && Date.now() - lastAppAt >= APP_GRACE_MS;
	const shown = closed ? null : showing;
	const head = closed ? queries.filter((x) => x.source === "pi" && x.options.length).sort((a, b) => a.createdAt - b.createdAt)[0] : null;
	if ((shown && shown.queryId) || head) {
		const qy = head || queries.find((x) => x.id === shown.queryId);
		const option = qy && qy.options.find((o) => o.toLowerCase() === text.trim().toLowerCase());
		if (!option) {
			if (head) console.log(`alert: Didn't catch that · ${head.label}: ${head.options.join(", ")}`);
			else broadcast({ type: "notice", text: qy ? "Didn't catch that" : "Already answered" });
			return { action: qy ? "no_match" : "gone", queryId: qy && qy.id };
		}
		if (head) console.log(`alert: Answered: ${option} · ${head.label}`);
		removeQuery(qy.id);
		return { action: "answered", queryId: qy.id };
	}
	const open = shown && sessions.find((x) => x.id === shown.sessionId);
	if (open) {
		prompt(open, text);
		return { action: "prompted", sessionId: open.id };
	}
	const s = newSession();
	prompt(s, text);
	return { action: "new_session", sessionId: s.id };
}

// --- HTTP -------------------------------------------------------------------

function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function readBody(req) {
	return new Promise((resolve) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch {
				resolve(null);
			}
		});
	});
}

async function handle(req, res) {
	const url = new URL(req.url, "http://stub");
	const q = url.searchParams;
	const path = url.pathname;
	console.log(`${req.method} ${path}${url.search}`);

	if (req.method === "GET") {
		if (path === "/dev/settings") return json(res, 200, { DARK });
		if (path === "/api/watch/pending") {
			const since = Number(q.get("since")) || 0;
			if (q.get("wait") !== "1" || cursor > since) return json(res, 200, pendingNow());
			const done = (p) => {
				clearTimeout(timer);
				json(res, 200, p);
			};
			const timer = setTimeout(() => {
				waiters.delete(done);
				lastAppAt = Date.now();
				json(res, 200, pendingNow());
			}, 25000);
			waiters.add(done);
			req.on("close", () => {
				if (waiters.delete(done)) lastAppAt = Date.now();
			});
			return;
		}
		if (path === "/api/watch/history") {
			const id = q.get("session");
			const s = sessions.find((x) => x.id === id) || (id === ERRORED.id && ERRORED);
			if (!s) return json(res, 404, { error: "Session not found" });
			if (fresh.has(id)) return json(res, 200, { turns: [], total: 0 });
			const turns = [
				{ i: 0, role: "you", text: prompts.get(id) ?? "Go on." },
				{ i: 1, role: "tool", text: "bash · npm test" },
				{ i: 2, role: "agent", text: streamed.get(id) ?? REPLIES[id] ?? (id.startsWith("m") ? LONG_REPLY(s.title) : "Done.") },
			];
			const limit = Math.min(Number(q.get("limit")) || 12, 50);
			return json(res, 200, { turns: turns.slice(-limit), total: turns.length });
		}
		if (path === "/api/watch/models") {
			if (!sessions.some((s) => s.id === q.get("session"))) return json(res, 404, { error: "Session not found" });
			return json(res, 200, { current: MODELS[0], models: MODELS });
		}
		return json(res, 404, { error: "not found" });
	}

	if (req.method === "POST") {
		const body = await readBody(req);
		if (!body) return json(res, 400, { error: "bad body" });
		console.log("  body", JSON.stringify(body));
		if (DELAY) await new Promise((done) => setTimeout(done, DELAY));
		if (path === "/api/watch/showing") {
			showing = { queryId: body.queryId ?? null, sessionId: body.sessionId ?? null };
			return json(res, 200, { ok: true });
		}
		if (path === "/api/watch/answer") {
			const query = queries.find((x) => x.id === body.queryId);
			if (!query) return json(res, 200, { ok: false, reason: "gone" });
			if (!query.options.includes(body.option)) return json(res, 200, { ok: false, reason: "no_match", options: query.options });
			removeQuery(query.id);
			return json(res, 200, { ok: true });
		}
		if (path === "/api/watch/skip") {
			removeQuery(body.queryId);
			return json(res, 200, { ok: true });
		}
		if (path === "/api/watch/abort") {
			const s = sessions.find((x) => x.id === body.sessionId);
			if (!s || s.status !== "running") return json(res, 200, { ok: false, reason: "gone" });
			Object.assign(s, { status: "done", state: "idle", updatedAt: Date.now() });
			changed();
			return json(res, 200, { ok: true });
		}
		if (path === "/api/watch/archive") {
			sessions = sessions.filter((x) => x.id !== body.sessionId);
			changed();
			return json(res, 200, { ok: true });
		}
		if (path === "/api/watch/prompt") {
			const s = sessions.find((x) => x.id === body.sessionId);
			if (s) prompt(s, body.text);
			return json(res, 200, { ok: true });
		}
		if (path === "/api/watch/new") return json(res, 200, { ok: true, sessionId: newSession().id });
		if (path === "/stub/ring") return json(res, 200, ring(String(body.text || "what's next?")));
		if (path === "/api/watch/model") return json(res, 200, { ok: true });
		if (path === "/stub/notice") {
			broadcast({ type: "notice", text: body.text || "Didn't catch that" });
			return json(res, 200, { ok: true });
		}
		if (path === "/stub/query") {
			const id = "q" + nextQuery++;
			const ring = body.source === "ring-profile";
			queries = [...queries, { id, source: ring ? "ring-profile" : "pi", sessionId: ring ? null : "s2", label: ring ? "ring · follow-up" : "pi · pi-web watch", text: body.text || "Allow edit?\nwatch/app/src/embeddedjs/main.js", options: body.options || ["Allow", "Deny"], createdAt: Date.now() }];
			changed();
			return json(res, 200, { ok: true, id });
		}
		if (path === "/stub/stream") {
			const id = body.sessionId || (showing && showing.sessionId);
			const s = sessions.find((x) => x.id === id);
			if (!s) return json(res, 404, { error: "no such session (open one or pass sessionId)" });
			startStream(s, Number(body.ms) || 250, Number(body.count) || 200);
			return json(res, 200, { ok: true, sessionId: s.id });
		}
		if (path === "/stub/dark") {
			DARK = Number(body.dark) ? 1 : 0;
			return json(res, 200, { ok: true, DARK });
		}
		return json(res, 404, { error: "not found" });
	}

	json(res, 405, { error: "method not allowed" });
}

const server = http.createServer((req, res) => {
	handle(req, res).catch((err) => {
		console.error(err);
		json(res, 500, { error: String(err) });
	});
});

// --- Stream -----------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	if (new URL(req.url, "http://stub").pathname !== "/api/watch/stream") {
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (ws) => {
	console.log("ws open");
	sockets.add(ws);
	ws.send(JSON.stringify({ type: "pending", ...pendingNow() }));
	ws.on("message", (m) => {
		console.log("ws <", String(m));
		try {
			const f = JSON.parse(String(m));
			if (f && f.type === "showing") showing = { queryId: f.queryId ?? null, sessionId: f.sessionId ?? null };
		} catch {}
	});
	ws.on("close", () => {
		console.log("ws close");
		sockets.delete(ws);
		lastAppAt = Date.now();
	});
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`stub hub on http://127.0.0.1:${PORT} scene=${SCENE} dark=${DARK}`);
});
