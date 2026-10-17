// GET /api/watch/stream: the watch's WebSocket. One pending frame on connect,
// then every frame WatchService emits; the client reports what it is showing.

import type { Server } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { checkHostAndLogin } from "./auth.ts";
import type { HubConfig } from "./config.ts";
import type { WatchService } from "./watch.ts";

export interface WatchStreamDeps {
	watch: WatchService;
	cfg: Pick<HubConfig, "hostname" | "allowedLogin">;
	log?: (m: string) => void;
	pingMs?: number;
}

export interface WatchStream {
	clientCount(): number;
	close(): void;
}

const refuse = (socket: import("node:stream").Duplex, line: string) => {
	socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
};

export function attachWatchStream(server: Server, deps: WatchStreamDeps): WatchStream {
	const { watch, cfg, log = () => {}, pingMs = 30_000 } = deps;
	const wss = new WebSocketServer({ noServer: true });
	const clients = new Set<WebSocket>();
	const alive = new WeakMap<WebSocket, boolean>();

	server.on("upgrade", (req, socket, head) => {
		const path = new URL(req.url ?? "/", "http://hub").pathname;
		if (path !== "/api/watch/stream") return refuse(socket, "404 Not Found");
		const auth = checkHostAndLogin(cfg, req.headers);
		if (!auth.ok) {
			log(`rejected UPGRADE ${req.url}: ${auth.reason}`);
			return refuse(socket, "403 Forbidden");
		}
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
	});

	wss.on("connection", (ws: WebSocket) => {
		clients.add(ws);
		alive.set(ws, true);
		ws.send(JSON.stringify({ type: "pending", ...watch.pending() }));
		const off = watch.subscribe((f) => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f));
		});
		ws.on("pong", () => alive.set(ws, true));
		ws.on("message", (data) => {
			let f: unknown;
			try {
				f = JSON.parse(String(data));
			} catch {
				f = null;
			}
			const m = f as { type?: unknown; requestId?: unknown; sessionId?: unknown } | null;
			const strOrNull = (v: unknown) => typeof v === "string" || v === null;
			if (m && m.type === "showing" && strOrNull(m.requestId) && (m.sessionId === undefined || strOrNull(m.sessionId))) {
				watch.showing(m.requestId as string | null, (m.sessionId as string | null | undefined) ?? null);
			} else {
				log("watch stream: ignored frame");
			}
		});
		ws.on("close", () => {
			off();
			clients.delete(ws);
		});
		ws.on("error", () => ws.terminate());
	});

	const timer = setInterval(() => {
		for (const ws of clients) {
			if (!alive.get(ws)) {
				ws.terminate();
				continue;
			}
			alive.set(ws, false);
			ws.ping();
		}
	}, pingMs);
	timer.unref();

	return {
		clientCount: () => clients.size,
		close() {
			clearInterval(timer);
			for (const ws of clients) ws.close(1001, "hub shutting down");
		},
	};
}
