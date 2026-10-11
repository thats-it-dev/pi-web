// The bridge's socket to the hub. Never throws and never prints: while the hub
// is down it retries quietly, 1s doubling to 60s (spec §7). Timers are unref'd
// so a waiting bridge never keeps pi alive.

import { type Socket, createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeToHub, HubToBridge } from "../shared/src/bridge.ts";
import { lineSplitter } from "../shared/src/jsonl.ts";

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_WEB_BRIDGE_SOCKET || join(env.PI_WEB_DATA_DIR || join(homedir(), ".config", "pi-web"), "bridge.sock");
}

export interface BridgeClientOptions {
	path: string;
	onOpen(): void;
	onMessage(msg: HubToBridge): void;
	minDelayMs?: number;
	maxDelayMs?: number;
}

export class BridgeClient {
	private opts: BridgeClientOptions;
	private sock: Socket | null = null;
	private ready = false;
	private stopped = false;
	private timer: NodeJS.Timeout | null = null;
	private delay: number;

	constructor(opts: BridgeClientOptions) {
		this.opts = opts;
		this.delay = opts.minDelayMs ?? 1000;
	}

	start(): void {
		this.open();
	}

	send(msg: BridgeToHub): boolean {
		if (!this.sock || !this.ready) return false;
		this.sock.write(`${JSON.stringify(msg)}\n`);
		return true;
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.sock?.end();
		this.sock = null;
		this.ready = false;
	}

	private open(): void {
		if (this.stopped) return;
		const sock = createConnection(this.opts.path);
		this.sock = sock;
		this.ready = false;
		sock.setEncoding("utf8");
		sock.on("connect", () => {
			if (this.sock !== sock) return;
			this.ready = true;
			this.delay = this.opts.minDelayMs ?? 1000;
			this.opts.onOpen();
		});
		sock.on(
			"data",
			lineSplitter((line) => {
				let msg: HubToBridge;
				try {
					msg = JSON.parse(line);
				} catch {
					return;
				}
				this.opts.onMessage(msg);
			}),
		);
		sock.on("error", () => {}); // "close" follows; retrying is the only reaction
		sock.on("close", () => {
			if (this.sock !== sock) return;
			this.sock = null;
			this.ready = false;
			this.retry();
		});
	}

	private retry(): void {
		if (this.stopped || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.open();
		}, this.delay);
		this.timer.unref();
		this.delay = Math.min(this.delay * 2, this.opts.maxDelayMs ?? 60_000);
	}
}
