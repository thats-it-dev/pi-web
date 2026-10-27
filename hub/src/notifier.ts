// Alerts for a closed app (spec §7). When no watch app is open, a question that appears or a
// turn that ends should still reach the wrist:
//   notification: a BlobDB notification through the phone's Developer Connection, with an Open
//     action that launches the watchapp on that question or session. It works only while the
//     Pebble phone app is in the foreground, so
//   auto: falls back to a Web Push (mirrored to the watch by the phone, but without Open).
// The Notifier is the one alert path: watchPush's turn pushes come here too (turnPush), so each
// event alerts once: a frame if the phone answers, else (auto) one Web Push.
// Every entry point catches and logs: callers are synchronous listeners and must not see a throw.

import { randomInt, randomUUID } from "node:crypto";
import type { PushPayload, WatchQuery } from "../../shared/src/protocol.ts";
import { notificationFrame } from "./notification-frame.ts";
import { clipText as clip } from "./push-watch.ts";

export type AlertMode = "auto" | "notification" | "push" | "off";

export type LaunchTarget = { queryId: string } | { sessionId: string };

export interface NotifierDeps {
	mode: AlertMode;
	appUuid: string;
	phone: () => string | null;
	appOpen: () => boolean;
	send?: (host: string, frame: Uint8Array) => Promise<boolean>;
	push: (p: PushPayload) => Promise<boolean>;
	markDelivered: (queryId: string) => void;
	log?: (m: string) => void;
	now?: () => number;
}

const SESSION_BIT = 0x80000000;
const CODE_MASK = 0x7fffffff;
const TABLE_MAX = 32;
const PUSH_BODY_MAX = 160;
const FRAME_BODY_MAX = 240;
const FRAME_TITLE_MAX = 64; // TimelineAttribute Title
const RING_BODY = "Question waiting";

export class Notifier {
	private deps: NotifierDeps;
	private targets = new Map<number, LaunchTarget>(); // oldest first
	private seq = 0;

	constructor(deps: NotifierDeps) {
		this.deps = deps;
	}

	// The watch sends the code it was launched with back; this says what it meant.
	launchTarget(code: number): LaunchTarget | null {
		return this.targets.get(code >>> 0) ?? null;
	}

	launchCodes(): IterableIterator<[number, LaunchTarget]> {
		return this.targets.entries();
	}

	async query(q: WatchQuery): Promise<void> {
		try {
			const { mode } = this.deps;
			if (mode === "off" || this.deps.appOpen()) return;
			let delivered = false;
			if (mode !== "push") delivered = await this.frame(q.label, q.text, this.code({ queryId: q.id }, false));
			if (!delivered && mode !== "notification") {
				// A ring question never leaves the machine in a push, whoever can read the lock screen.
				const body = q.source === "ring-profile" ? RING_BODY : clip(q.text, PUSH_BODY_MAX);
				delivered = await this.deps.push({ sessionId: q.sessionId ?? "", title: q.label, kind: "query", body });
			}
			if (delivered) this.deps.markDelivered(q.id);
		} catch (err) {
			this.log(`notifier: query ${q.id}: ${(err as Error).message}`);
		}
	}

	// A finished or error turn from watchPush (already body-filled and clipped). needs_you is the
	// pi query path's job, so it is ignored here.
	async turnPush(p: PushPayload): Promise<void> {
		try {
			const { mode } = this.deps;
			if ((p.kind !== "finished" && p.kind !== "error") || mode === "off" || this.deps.appOpen()) return;
			let sent = false;
			if (mode !== "push") sent = await this.frame(p.title, p.body ?? "", this.code({ sessionId: p.sessionId }, true));
			if (!sent && mode !== "notification") await this.deps.push(p);
		} catch (err) {
			this.log(`notifier: turn ${p.sessionId}: ${(err as Error).message}`);
		}
	}

	// True when the frame went out. False when there is no phone, no sender or the socket failed.
	private async frame(title: string, body: string, launchCode: number): Promise<boolean> {
		const host = this.deps.phone();
		if (host === null || !this.deps.send) return false;
		try {
			const f = notificationFrame({
				appUuid: this.deps.appUuid,
				itemId: randomUUID(),
				token: randomInt(0, 0x10000),
				time: Math.floor((this.deps.now ?? Date.now)() / 1000),
				title: clip(title, FRAME_TITLE_MAX),
				body: clip(body, FRAME_BODY_MAX),
				launchCode,
			});
			return await this.deps.send(host, f);
		} catch (err) {
			this.log(`notifier: frame to ${host} failed: ${(err as Error).message}`);
			return false;
		}
	}

	// Session alerts have the high bit set; the low 31 bits count up.
	private code(target: LaunchTarget, session: boolean): number {
		this.seq = (this.seq + 1) & CODE_MASK;
		const code = ((session ? SESSION_BIT : 0) | this.seq) >>> 0;
		this.targets.delete(code);
		this.targets.set(code, target);
		while (this.targets.size > TABLE_MAX) this.targets.delete(this.targets.keys().next().value as number);
		return code;
	}

	private log(m: string): void {
		try {
			(this.deps.log ?? ((x) => console.log(x)))(m);
		} catch {}
	}
}
