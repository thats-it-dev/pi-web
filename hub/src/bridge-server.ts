// The hub's end of the bridge (spec §2.3): a private Unix socket terminal pi
// processes connect to. There is one connection per pi extension runtime. A TUI
// /new, /resume or /fork replaces the runtime, so the same pid says bye on one
// connection and hello on the next, in either order; the pid's BridgeHandle
// survives the switch for a grace period and follows it.

import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { type Socket, createConnection, createServer } from "node:net";
import { dirname } from "node:path";
import { BRIDGE_PROTOCOL, type BridgeHello, type BridgeToHub, type ByeReason, type HubToBridge } from "../../shared/src/bridge.ts";
import { lineSplitter } from "../../shared/src/jsonl.ts";
import { type BridgeConn, BridgeHandle } from "./bridge-handle.ts";

export interface BridgeServerOptions {
	socketPath: string;
	registry: { attachBridge(h: BridgeHandle): "attached" | "waiting" | "ignored" };
	switchGraceMs?: number;
	helloTimeoutMs?: number;
	log?: (msg: string) => void;
}

export interface BridgeServer {
	close(): Promise<void>;
}

interface Entry {
	handle: BridgeHandle;
	sock: Socket | null; // the connection of the pid's current runtime
	grace: NodeJS.Timeout | null; // running while a runtime switch is under way
}

export async function startBridgeServer(opts: BridgeServerOptions): Promise<BridgeServer> {
	const log = opts.log ?? (() => {});
	const graceMs = opts.switchGraceMs ?? 5000;
	const dir = dirname(opts.socketPath);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	if (existsSync(opts.socketPath)) {
		if (await answers(opts.socketPath)) throw new Error(`Another pi-web hub is listening on ${opts.socketPath}`);
		unlinkSync(opts.socketPath); // left by a hub that crashed
	}

	const byPid = new Map<number, Entry>();
	const sockets = new Set<Socket>();

	const end = (pid: number, e: Entry) => {
		if (e.grace) clearTimeout(e.grace);
		if (byPid.get(pid) === e) byPid.delete(pid);
		log(`terminal pi ${pid} left ${e.handle.sessionId}`);
		e.handle.gone();
	};

	const onBye = (pid: number, e: Entry, reason: ByeReason) => {
		if (reason === "quit") return end(pid, e);
		e.handle.detach();
		if (e.grace) clearTimeout(e.grace);
		e.grace = setTimeout(() => end(pid, e), graceMs);
		e.grace.unref();
	};

	const server = createServer((sock) => {
		sockets.add(sock);
		sock.setEncoding("utf8");
		sock.on("error", () => {});
		let pid: number | null = null;
		let ignored = false;
		const helloTimer = setTimeout(() => sock.destroy(), opts.helloTimeoutMs ?? 5000);
		const conn: BridgeConn = { send: (m) => write(sock, m), close: () => sock.destroy() };

		const onHello = (hello: BridgeHello) => {
			clearTimeout(helloTimer);
			if (hello.protocol !== BRIDGE_PROTOCOL) {
				write(sock, { type: "notice", text: `pi-web: this bridge speaks protocol ${hello.protocol} but the hub speaks ${BRIDGE_PROTOCOL}. Update pi-web.` });
				sock.end();
				return;
			}
			pid = hello.pid;
			const e = byPid.get(pid);
			if (e) {
				// The same pi process with a new runtime (or a duplicate session_start).
				if (e.grace) clearTimeout(e.grace);
				e.grace = null;
				const old = e.sock;
				e.sock = sock;
				if (old && old !== sock) old.destroy();
				e.handle.rebind(conn, hello);
				return;
			}
			const handle = new BridgeHandle(conn, hello);
			if (opts.registry.attachBridge(handle) === "ignored") {
				ignored = true;
				return;
			}
			byPid.set(pid, { handle, sock, grace: null });
			log(`terminal pi ${pid} attached ${hello.sessionId}`);
		};

		sock.on(
			"data",
			lineSplitter((line) => {
				try {
					const msg = JSON.parse(line) as BridgeToHub;
					if (!msg || typeof msg !== "object") throw new Error("not an object");
					if (msg.type === "hello") {
						if (ignored) return;
						return onHello(msg);
					}
					if (ignored || pid === null) return;
					const e = byPid.get(pid);
					if (!e || e.sock !== sock) return; // late messages from a replaced runtime
					if (msg.type === "bye") return onBye(pid, e, msg.reason);
					e.handle.receive(msg);
				} catch (err) {
					log(`dropping a bridge connection after a bad message: ${(err as Error).message}`);
					sock.destroy();
				}
			}),
		);

		sock.on("close", () => {
			clearTimeout(helloTimer);
			sockets.delete(sock);
			if (pid === null) return;
			const e = byPid.get(pid);
			if (!e || e.sock !== sock) return;
			e.sock = null;
			if (!e.grace) end(pid, e); // gone without a session switch under way
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	chmodSync(opts.socketPath, 0o600);

	return {
		async close() {
			for (const [pid, e] of [...byPid]) end(pid, e);
			for (const s of sockets) s.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
		},
	};
}

function write(sock: Socket, msg: HubToBridge): void {
	if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`);
}

function answers(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createConnection(path);
		s.once("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.once("error", () => resolve(false));
	});
}
