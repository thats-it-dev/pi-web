// A stand-in hub for the emulator: canned watch data, no auth.
// Run from the repo root (ws resolves from the root node_modules):
//   node watch/app/dev/stub-hub.mjs --port 5173 [--scene dialog|finished|empty|stream] [--dark 0|1] [--delay ms]
// --delay holds every POST's answer that long (to see the watch's `sending…` state).
import http from "node:http";
import { WebSocketServer } from "ws";

// --- Fixtures ---------------------------------------------------------------

const NOW = Date.now();
const MIN = 60 * 1000;

const LIVE = [
	{ id: "s1", title: "pi-web watch", state: "running", live: true, model: "qwen3", contextPercent: 41, contextTokens: 53700, contextWindow: 131072, tps: 62, updatedAt: NOW - 1 * MIN },
	{ id: "s2", title: "notesky sync", state: "needs_you", live: true, model: "qwen3", contextPercent: 18, contextTokens: 23600, contextWindow: 131072, tps: null, updatedAt: NOW - 4 * MIN },
	{ id: "s3", title: "llmwiki cron", state: "idle", live: true, model: "gpt-oss", contextPercent: 7, contextTokens: 9200, contextWindow: 131072, tps: null, updatedAt: NOW - 30 * MIN },
];

const CLOSED_TITLES = ["fix ios chin", "pebble alloy spike", "hub auth", "push dedupe", "readme pass", "weather route", "history paging", "model picker", "ring webhook", "stpyv8 wheel", "clay settings", "piu list", "dictation", "theme toggle", "sessions menu", "tailscale serve", "deploy notes", "bridge tests", "stub hub", "screenshots", "gabbro centring", "say it again", "release 0.2"];
const CLOSED = CLOSED_TITLES.map((title, n) => ({
	id: "c" + (n + 1),
	title,
	state: "idle",
	live: false,
	model: n % 3 ? "qwen3" : null,
	contextPercent: null,
	contextTokens: 1000 * (n + 3),
	contextWindow: null,
	tps: null,
	updatedAt: NOW - (n + 1) * 5 * 60 * MIN,
}));

const SESSIONS = [...LIVE, ...CLOSED];

const DIALOG = {
	id: "dialog:s2:d1",
	kind: "dialog",
	sessionId: "s2",
	sessionTitle: "notesky sync",
	tool: "bash",
	message: "Allow bash?\ngit push origin main",
	options: ["allow", "deny"],
	method: "select",
	createdAt: NOW - 2 * MIN,
};
const FINISHED = {
	id: "finished:s1:12",
	kind: "finished",
	sessionId: "s1",
	sessionTitle: "pi-web watch",
	tool: "question",
	message: "Done. The bridge tests pass and the build is clean. Want me to run the emulator smoke test next?",
	options: [],
	method: null,
	createdAt: NOW - 1 * MIN,
};

const SCENES = {
	dialog: [DIALOG, FINISHED],
	finished: [FINISHED],
	empty: [],
	stream: [],
};

const LONG = "This line is long on purpose so the history view has to wrap it over several rows and the phone has to chunk the page across more than one AppMessage. ".repeat(2).slice(0, 240);
const HISTORY = {};
for (const s of SESSIONS) {
	const turns = [];
	for (let i = 0; i < 40; i++) {
		const role = i % 5 === 3 ? "tool" : i % 2 ? "agent" : "you";
		const text = role === "tool" ? "bash npm test" : i % 4 === 1 ? LONG : `${role === "you" ? "Question" : "Answer"} ${i} for ${s.title}.`;
		turns.push({ i, role, text });
	}
	HISTORY[s.id] = turns;
}

const MODELS = [
	{ provider: "spark", id: "qwen3-30b-a3b", name: "Qwen3 30B A3B" },
	{ provider: "spark", id: "gpt-oss-120b", name: "gpt-oss 120B" },
	{ provider: "spark", id: "gemma3-27b", name: "Gemma 3 27B" },
	{ provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
];

const STREAM_SENTENCES = [
	"Reading the bridge first.",
	" The outbox keeps one dict in flight.",
	" Home, stats and text coalesce to the latest.",
	" Results and lists stay in order.",
	" Stats go at most once a second.",
	" A failed send is retried once after half a second.",
	" Then it is dropped and logged.",
	" That is everything the watch needs.",
];

// --- Args -------------------------------------------------------------------

function arg(name, fallback) {
	const i = process.argv.indexOf("--" + name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = Number(arg("port", "5173"));
const SCENE = arg("scene", "dialog");
const DARK = Number(arg("dark", "1")) ? 1 : 0;
const DELAY = Number(arg("delay", "0")) || 0;
if (!SCENES[SCENE]) {
	console.error(`unknown scene ${SCENE}; use dialog, finished, empty or stream`);
	process.exit(2);
}

// --- State ------------------------------------------------------------------

let cursor = 1;
let requests = SCENES[SCENE].slice();
let showing = null;
const waiters = new Set();
const sockets = new Set();

function pendingNow() {
	return { cursor, requests, showing, sessions: SESSIONS };
}

function changed() {
	cursor++;
	const p = pendingNow();
	for (const w of waiters) w(p);
	waiters.clear();
	for (const ws of sockets) ws.send(JSON.stringify({ type: "pending", ...p }));
}

function removeRequest(id) {
	const before = requests.length;
	requests = requests.filter((r) => r.id !== id);
	if (showing === id) showing = null;
	if (requests.length !== before) changed();
	return requests.length !== before;
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
	console.log(`${req.method} ${url.pathname}${url.search}`);

	if (req.method === "GET") {
		if (path === "/dev/settings") return json(res, 200, { DARK });
		if (path === "/api/watch/health") return json(res, 200, { ok: true, hubVersion: "stub", sessions: { running: 1, pending: requests.length } });
		if (path === "/api/watch/sessions") return json(res, 200, { sessions: SESSIONS });
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
			const turns = HISTORY[q.get("session")];
			if (!turns) return json(res, 404, { error: "Session not found" });
			const limit = Math.min(Number(q.get("limit")) || 12, 50);
			const before = q.has("before") ? Math.max(0, Math.min(Number(q.get("before")), turns.length)) : turns.length;
			return json(res, 200, { turns: turns.slice(Math.max(0, before - limit), before), total: turns.length });
		}
		if (path === "/api/watch/models") {
			if (!LIVE.some((s) => s.id === q.get("session"))) return json(res, 404, { error: "Session not found" });
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
			showing = body.requestId ?? null;
			return json(res, 200, { ok: true });
		}
		if (path === "/api/watch/answer") {
			const r = requests.find((x) => x.id === body.requestId);
			if (!r) return json(res, 200, { ok: false, reason: "gone" });
			// On the dialog scene, dictated text never matches: exercises no_match.
			if (SCENE === "dialog" && r.kind === "dialog" && typeof body.text === "string") return json(res, 200, { ok: false, reason: "no_match", options: r.options });
			removeRequest(r.id);
			return json(res, 200, { ok: true });
		}
		if (path === "/api/watch/dismiss") {
			removeRequest(body.requestId);
			return json(res, 200, { ok: true });
		}
		if (path === "/api/watch/prompt" || path === "/api/watch/model") return json(res, 200, { ok: true });
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
	let streamTimer = null;
	if (SCENE === "stream") {
		LIVE[0].state = "running";
		const start = Date.now();
		let text = "";
		let n = 0;
		streamTimer = setInterval(() => {
			if (Date.now() - start >= 6000) {
				clearInterval(streamTimer);
				streamTimer = null;
				ws.send(JSON.stringify({ type: "text", sessionId: "s1", text: text.slice(-240), streaming: false }));
				// The turn is over: s1 goes idle (the watch's speed figure stops blinking).
				LIVE[0].state = "idle";
				changed();
				return;
			}
			text += (n ? " " : "") + STREAM_SENTENCES[n++ % STREAM_SENTENCES.length].trim();
			ws.send(JSON.stringify({ type: "text", sessionId: "s1", text: text.slice(-240), streaming: true }));
		}, 250);
	}
	ws.on("message", (m) => {
		console.log("ws <", String(m));
		try {
			const f = JSON.parse(String(m));
			if (f && f.type === "showing") showing = f.requestId ?? null;
		} catch {}
	});
	ws.on("close", () => {
		console.log("ws close");
		sockets.delete(ws);
		if (streamTimer) clearInterval(streamTimer);
	});
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`stub hub on http://127.0.0.1:${PORT} scene=${SCENE} dark=${DARK}`);
});
