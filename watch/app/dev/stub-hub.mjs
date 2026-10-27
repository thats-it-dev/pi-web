// A stand-in hub for the emulator: canned watch data in the query protocol
// (shared/src/protocol.ts WatchPending), no auth.
// Run from the repo root (ws resolves from the root node_modules):
//   node watch/app/dev/stub-hub.mjs --port 5173 [--scene default|all|empty|ring|many] [--dark 0|1] [--delay ms]
// Scenes: default = three sessions (waiting, running, done) and a pi query on the waiting one;
// all = the same plus a session in error; empty = no sessions, no queries;
// ring = the default plus a ring-profile query; many = twelve sessions with
// ~40-char titles and ~600-char replies (the phone's row limit; Home's memory).
// POST /stub/notice {text} sends a notice frame; POST /stub/query {text?, options?, source?} raises a query;
// POST /stub/dark {dark: 0|1} changes what /dev/settings reports (the phone reads it at start).
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

// many: twelve rows (the bridge's HOME_ROWS), titles near the bridge's 40-char clip.
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
];
const MANY_STATUS = ["waiting", "running", "done", "error", "running", "done", "done", "running", "done", "done", "running", "done"];
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
let nextQuery = 3;
const waiters = new Set();
const sockets = new Set();

const pendingNow = () => ({ cursor, queries, showing, sessions });

function broadcast(frame) {
	for (const ws of sockets) ws.send(JSON.stringify(frame));
}

function changed() {
	cursor++;
	const p = pendingNow();
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

// Launch codes: 1 opens the first query; 2, or 0x80000001-0x800000FF (the
// session bit, as the hub's Notifier marks session alerts), the first session.
// Anything else (e.g. 0x80001000) is unknown: 404.
function launchTarget(code) {
	if (code === 1 && queries[0]) return { queryId: queries[0].id };
	if ((code === 2 || (code > 0x80000000 && code < 0x80000100)) && sessions[0]) return { sessionId: sessions[0].id };
	return null;
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
				json(res, 200, pendingNow());
			}, 25000);
			waiters.add(done);
			req.on("close", () => waiters.delete(done));
			return;
		}
		if (path === "/api/watch/history") {
			const id = q.get("session");
			const s = sessions.find((x) => x.id === id) || (id === ERRORED.id && ERRORED);
			if (!s) return json(res, 404, { error: "Session not found" });
			const turns = [
				{ i: 0, role: "you", text: "Go on." },
				{ i: 1, role: "tool", text: "bash · npm test" },
				{ i: 2, role: "agent", text: REPLIES[id] || (id.startsWith("m") ? LONG_REPLY(s.title) : "Done.") },
			];
			const limit = Math.min(Number(q.get("limit")) || 12, 50);
			return json(res, 200, { turns: turns.slice(-limit), total: turns.length });
		}
		if (path === "/api/watch/models") {
			if (!sessions.some((s) => s.id === q.get("session"))) return json(res, 404, { error: "Session not found" });
			return json(res, 200, { current: MODELS[0], models: MODELS });
		}
		if (path === "/api/watch/launch-target") {
			const target = launchTarget(Number(q.get("code")));
			return target ? json(res, 200, target) : json(res, 404, { error: "unknown code" });
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
			if (s) {
				Object.assign(s, { status: "running", state: "running", updatedAt: Date.now() });
				changed();
			}
			return json(res, 200, { ok: true });
		}
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
		showing = null;
	});
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`stub hub on http://127.0.0.1:${PORT} scene=${SCENE} dark=${DARK}`);
});
