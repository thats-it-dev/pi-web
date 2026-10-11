import { type IncomingHttpHeaders, request } from "node:http";

export interface Resp {
	status: number;
	headers: IncomingHttpHeaders;
	body: any;
}

const clean = (h: Record<string, string | undefined>) => Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)) as Record<string, string>;

export function call(port: number, method: string, path: string, headers: Record<string, string | undefined>, body?: unknown): Promise<Resp> {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const req = request({ host: "127.0.0.1", port, method, path, headers: clean({ ...headers, "content-type": data ? "application/json" : undefined }) }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (text += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? JSON.parse(text) : null }));
		});
		req.on("error", reject);
		req.end(data);
	});
}

export interface SseClient {
	messages: unknown[];
	next(pred: (m: { type?: string; [k: string]: unknown }) => boolean, timeoutMs?: number): Promise<{ type?: string; [k: string]: unknown }>;
	close(): void;
}

export function openSse(port: number, path: string, headers: Record<string, string | undefined>): Promise<SseClient> {
	return new Promise((resolve, reject) => {
		const messages: Array<{ type?: string }> = [];
		const waiters: Array<{ pred: (m: { type?: string }) => boolean; resolve: (m: { type?: string }) => void }> = [];
		const req = request({ host: "127.0.0.1", port, path, headers: clean(headers) }, (res) => {
			if (res.statusCode !== 200) return reject(new Error(`SSE status ${res.statusCode}`));
			let buf = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				buf += chunk;
				let i = buf.indexOf("\n\n");
				while (i !== -1) {
					const frame = buf.slice(0, i);
					buf = buf.slice(i + 2);
					for (const line of frame.split("\n")) {
						if (!line.startsWith("data: ")) continue;
						const msg = JSON.parse(line.slice(6));
						messages.push(msg);
						for (const w of [...waiters]) {
							if (!w.pred(msg)) continue;
							waiters.splice(waiters.indexOf(w), 1);
							w.resolve(msg);
						}
					}
					i = buf.indexOf("\n\n");
				}
			});
			resolve({
				messages,
				next(pred, timeoutMs = 5000) {
					const hit = messages.find((m) => pred(m));
					if (hit) {
						messages.splice(messages.indexOf(hit), 1);
						return Promise.resolve(hit);
					}
					return new Promise((res2, rej2) => {
						const timer = setTimeout(() => rej2(new Error("timed out waiting for SSE message")), timeoutMs);
						waiters.push({ pred, resolve: (m) => (clearTimeout(timer), messages.splice(messages.indexOf(m), 1), res2(m)) });
					});
				},
				close: () => req.destroy(),
			});
		});
		req.on("error", (e) => (e.message === "socket hang up" ? undefined : reject(e)));
		req.end();
	});
}
