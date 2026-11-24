// Which pi process (if any) is serving each session. Starts headless pi on
// demand, follows sessions that move (fork/clone/new), keeps at most
// maxHeadless running, closes idle ones, and decides between a headless pi
// and a terminal pi that want the same session (spec §3.2).

import type { HandleKind, ListMessage, LiveState, SessionType } from "../../shared/src/protocol.ts";
import { HttpError } from "./errors.ts";
import type { SessionHandle } from "./handle.ts";
import type { ModelChoice } from "./last-model.ts";
import type { SessionTypeStore } from "./session-types.ts";

export const BUSY_NOTICE = "This session is running in pi-web. Wait for it to finish, or /quit.";
export const ELSEWHERE_NOTICE = "This session is open in another terminal; pi-web follows that one.";
export const FREE_NOTICE = "This session is free now. /resume it to continue here with the latest messages.";

export interface HandleFactory {
	startRpc(opts: { cwd: string; sessionFile?: string; model?: ModelChoice | null; type: SessionType }): Promise<SessionHandle>;
}

export interface SessionLookup {
	find(id: string): Promise<{ cwd: string; file: string; parentSession: string | null } | null>;
}

export interface RegistryOptions {
	factory: HandleFactory;
	lookup: SessionLookup;
	maxHeadless: number;
	idleMs: number;
	now?: () => number;
	types?: Pick<SessionTypeStore, "get" | "set">; // main.ts passes the persistent store; unset, types live in memory
}

export interface LiveInfo {
	live: boolean;
	handleKind: HandleKind | null;
	state: LiveState;
}

export class Registry {
	private opts: RegistryOptions;
	private types: Pick<SessionTypeStore, "get" | "set">;
	private handles = new Map<string, SessionHandle>();
	private starting = new Map<string, Promise<SessionHandle>>();
	private pending = 0;
	private unsubscribers = new Map<SessionHandle, () => void>();
	private errors = new Map<string, string>();
	private listeners = new Set<(m: ListMessage) => void>();
	private waiting = new Map<SessionHandle, () => void>(); // terminals waiting for a session another handle holds

	constructor(opts: RegistryOptions) {
		this.opts = opts;
		if (opts.types) this.types = opts.types;
		else {
			const chats = new Set<string>();
			this.types = { get: (id) => (chats.has(id) ? "chat" : "code"), set: (id, t) => void (t === "chat" ? chats.add(id) : chats.delete(id)) };
		}
	}

	get(id: string): SessionHandle | undefined {
		return this.handles.get(id);
	}

	all(): SessionHandle[] {
		return [...new Set(this.handles.values())];
	}

	info(id: string): LiveInfo {
		const h = this.handles.get(id);
		if (h) return { live: true, handleKind: h.kind, state: h.liveState() };
		return { live: false, handleKind: null, state: this.errors.has(id) ? "error" : "idle" };
	}

	lastError(id: string): string | undefined {
		return this.errors.get(id);
	}

	onChange(fn: (m: ListMessage) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	async ensure(id: string): Promise<SessionHandle> {
		const live = this.handles.get(id);
		if (live) return live;
		const inFlight = this.starting.get(id);
		if (inFlight) return inFlight;
		const p = (async () => {
			const found = await this.opts.lookup.find(id);
			if (!found) throw new HttpError(404, "Session not found");
			return this.launch({ cwd: found.cwd, sessionFile: found.file, type: this.typeOf(id, found.parentSession) });
		})();
		this.starting.set(id, p);
		try {
			return await p;
		} finally {
			this.starting.delete(id);
		}
	}

	async create(cwd: string, choice?: ModelChoice | null, type: SessionType = "code"): Promise<SessionHandle> {
		const h = await this.launch(choice ? { cwd, model: choice, type } : { cwd, type });
		// The session id is only known once pi has started.
		if (type === "chat") this.types.set(h.sessionId, "chat");
		return h;
	}

	// A session's type: the store's record, else its parent's (a child session starts as its parent was), else code.
	typeOf(id: string, parentSession?: string | null): SessionType {
		const own = this.types.get(id);
		if (own === "chat") return own;
		return parentSession ? this.types.get(parentSession) : "code";
	}

	close(id: string): void {
		const h = this.handles.get(id);
		if (h?.kind !== "rpc") return;
		this.forget(h);
		h.close();
	}

	closeAll(): void {
		for (const h of this.all()) {
			if (h.kind !== "rpc") continue;
			this.forget(h);
			h.close();
		}
	}

	reap(): void {
		const now = (this.opts.now ?? Date.now)();
		for (const h of this.all()) {
			if (h.kind === "rpc" && this.isIdle(h) && now - h.lastActive > this.opts.idleMs) {
				this.forget(h);
				h.close();
			}
		}
	}

	// A terminal pi announced itself over the bridge socket. The bridge server calls this
	// again on every hello from the same terminal, so a handle already tracked stays as it is.
	attachBridge(h: SessionHandle): "attached" | "waiting" | "ignored" {
		if (this.unsubscribers.has(h)) return "attached";
		if (this.waiting.has(h)) return "waiting";
		if (this.all().some((x) => x.kind === "rpc" && x.pid === h.pid)) return "ignored"; // our own headless child
		return this.claim(h);
	}

	private claim(h: SessionHandle): "attached" | "waiting" {
		const holder = this.handles.get(h.sessionId);
		if (holder && holder !== h) {
			if (holder.kind !== "rpc" || holder.isBusy() || holder.hasBackgroundJobs()) {
				this.wait(h);
				h.notice?.(holder.kind === "rpc" ? BUSY_NOTICE : ELSEWHERE_NOTICE);
				return "waiting";
			}
			this.forget(holder, false);
			holder.close();
		}
		this.adopt(h);
		return "attached";
	}

	private wait(h: SessionHandle): void {
		const off = h.onEvent((e) => {
			if (e.type !== "exit" && e.type !== "session_changed") return;
			off();
			this.waiting.delete(h);
			if (e.type === "session_changed") this.claim(h);
		});
		this.waiting.set(h, off);
	}

	// The holder let go. A waiting terminal loaded the session file before the holder's
	// latest turns and pi never re-reads it, so it is not promoted (spec §3.2): each waiter
	// is told, and its /resume (a fresh hello) claims the session with the latest messages.
	private freeWaiters(id: string): void {
		for (const [h, off] of [...this.waiting]) {
			if (h.sessionId !== id) continue;
			off();
			this.waiting.delete(h);
			h.notice?.(FREE_NOTICE);
		}
	}

	private isIdle(h: SessionHandle): boolean {
		return h.subscriberCount() === 0 && !h.isBusy() && !h.hasBackgroundJobs();
	}

	private async launch(o: Parameters<HandleFactory["startRpc"]>[0]): Promise<SessionHandle> {
		this.makeRoom();
		this.pending++;
		try {
			const h = await this.opts.factory.startRpc(o);
			const holder = this.handles.get(h.sessionId);
			if (holder) {
				// A terminal attached while this pi was starting: the terminal wins (spec §3.2).
				h.close();
				return holder;
			}
			this.adopt(h);
			return h;
		} finally {
			this.pending--;
		}
	}

	private makeRoom(): void {
		const headless = this.all().filter((h) => h.kind === "rpc");
		if (headless.length + this.pending < this.opts.maxHeadless) return;
		const victim = headless.filter((h) => this.isIdle(h)).sort((a, b) => a.lastActive - b.lastActive)[0];
		if (!victim) throw new HttpError(503, `${this.opts.maxHeadless} pi sessions are already running. Close one first.`);
		this.forget(victim);
		victim.close();
	}

	private adopt(h: SessionHandle): void {
		this.errors.delete(h.sessionId);
		this.handles.set(h.sessionId, h);
		const off = h.onEvent((e) => {
			switch (e.type) {
				case "state_changed":
					this.emitState(h.sessionId);
					if (h.kind === "rpc" && !h.isBusy() && !h.hasBackgroundJobs()) this.freeWaiters(h.sessionId);
					break;
				case "renamed":
					this.emit({ type: "session_list_changed" });
					break;
				case "session_changed": {
					const holder = this.handles.get(e.to);
					if (holder && holder !== h) {
						// A terminal moved onto a session someone else holds.
						this.forget(h);
						this.claim(h);
						break;
					}
					// Only a hub child's new_session/fork/clone carries chat over; a terminal's /resume or /fork
					// (a bridge) moves onto a session that already has its own type.
					if (h.kind === "rpc" && this.types.get(e.from) === "chat") this.types.set(e.to, "chat");
					if (this.handles.get(e.from) === h) this.handles.delete(e.from);
					this.handles.set(e.to, h);
					this.emitState(e.from);
					this.emitState(e.to);
					this.emit({ type: "session_list_changed" });
					this.freeWaiters(e.from);
					break;
				}
				case "exit":
					this.forget(h);
					if (!e.closedByHub && e.code !== 0) {
						this.errors.set(h.sessionId, e.stderr || `pi exited with code ${e.code}`);
						this.emitState(h.sessionId);
					}
					break;
			}
		});
		this.unsubscribers.set(h, off);
		this.emitState(h.sessionId);
	}

	private forget(h: SessionHandle, freeWaiters = true): void {
		this.unsubscribers.get(h)?.();
		this.unsubscribers.delete(h);
		const freed: string[] = [];
		for (const [id, x] of [...this.handles]) {
			if (x !== h) continue;
			this.handles.delete(id);
			this.emitState(id);
			freed.push(id);
		}
		if (freeWaiters) for (const id of freed) this.freeWaiters(id);
	}

	private emitState(id: string): void {
		this.emit({ type: "session_state", sessionId: id, ...this.info(id) });
	}

	private emit(m: ListMessage): void {
		for (const fn of this.listeners) fn(m);
	}
}
