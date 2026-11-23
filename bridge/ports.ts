import { createConnection, createServer } from "node:net";

export const SERVE_PORT_MIN = 10600;
export const SERVE_PORT_MAX = 10649;

/** A free TCP port on 127.0.0.1 (listen on 0, read the port, close). */
export function freeLocalPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (typeof addr === "object" && addr) {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close();
				reject(new Error("no address for ephemeral listener"));
			}
		});
	});
}

/** Whether something accepts a TCP connection on 127.0.0.1:port (500 ms timeout). */
export function isListening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
			resolve(false);
			return;
		}
		let sock: ReturnType<typeof createConnection>;
		try {
			sock = createConnection({ host: "127.0.0.1", port });
		} catch {
			resolve(false);
			return;
		}
		let done = false;
		const finish = (ok: boolean) => {
			if (done) return;
			done = true;
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(500);
		sock.once("connect", () => finish(true));
		sock.once("error", () => finish(false));
		sock.once("timeout", () => finish(false));
	});
}

/** The lowest port in [SERVE_PORT_MIN, SERVE_PORT_MAX] not in `taken`; null when all are. */
export function pickServePort(taken: Iterable<number>): number | null {
	const used = new Set(taken);
	for (let p = SERVE_PORT_MIN; p <= SERVE_PORT_MAX; p++) {
		if (!used.has(p)) return p;
	}
	return null;
}
