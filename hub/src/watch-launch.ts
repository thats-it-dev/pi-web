// Launching the watchapp from the hub: the phone's Developer Connection (a WebSocket
// on port 9000) relays a binary frame to the watch. The frame is RelayToWatch (0x01),
// a big-endian length (17) and endpoint (0x0034, AppRunState), then START (0x01) and
// the app uuid.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function launchFrame(uuid: string): Uint8Array {
	if (!UUID_RE.test(uuid)) throw new Error("A valid uuid is required");
	const f = new Uint8Array(22);
	f.set([0x01, 0x00, 0x11, 0x00, 0x34, 0x01]);
	f.set(Buffer.from(uuid.replaceAll("-", ""), "hex"), 6);
	return f;
}

export type LaunchResult = { ok: true } | { ok: false; reason: "unreachable" };

export interface PhoneOpts {
	port?: number;
	timeoutMs?: number;
	WebSocketCtor?: typeof WebSocket;
}

export function launchOnPhone(host: string, uuid: string, opts: PhoneOpts = {}): Promise<LaunchResult> {
	return sendToPhone(host, launchFrame(uuid), opts);
}

// Opens the Developer Connection, sends one frame and closes. ok means the frame went out.
export function sendToPhone(host: string, frame: Uint8Array, opts: PhoneOpts = {}): Promise<LaunchResult> {
	const WS = opts.WebSocketCtor ?? globalThis.WebSocket;
	return new Promise((resolve) => {
		let ws: WebSocket | undefined;
		let done = false;
		const settle = (r: LaunchResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				ws?.close();
			} catch {}
			resolve(r);
		};
		const timer = setTimeout(() => settle({ ok: false, reason: "unreachable" }), opts.timeoutMs ?? 5000);
		try {
			const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
			ws = new WS(`ws://${bracketed}:${opts.port ?? 9000}/`);
			ws.binaryType = "arraybuffer";
			ws.addEventListener("open", () => {
				ws?.send(frame);
				settle({ ok: true });
			});
			ws.addEventListener("error", () => settle({ ok: false, reason: "unreachable" }));
			ws.addEventListener("close", () => settle({ ok: false, reason: "unreachable" }));
		} catch {
			settle({ ok: false, reason: "unreachable" });
		}
	});
}
