// What the Pebble watch shows and answers (spec §4, §5). Requests are derived
// on demand from the live handles' pending dialogs plus a small record of turns
// that finished or errored while no app was open. The service also keeps the
// watch's dismissals and what it reports as on screen, and wakes long-pollers.

import type { AppCommand, Dialog, WatchAnswerResult, WatchPending, WatchRequest, WatchSession, WatchTurn } from "../../shared/src/protocol.ts";
import { matchOption } from "./answer-match.ts";
import { HttpError } from "./errors.ts";
import { sessionTitle, type Viewers } from "./push-watch.ts";
import type { Registry } from "./registry.ts";
import type { SessionIndex } from "./sessions.ts";
import { watchTurns } from "./turns.ts";

const MESSAGE_MAX = 240;
const LAST_SHOWN_MAX = 10;
const WAIT_MS = 25_000;

export interface WatchDeps {
	registry: Registry;
	index: SessionIndex;
	viewers: Viewers;
	home: string;
	now?: () => number;
	log?: (m: string) => void;
}

interface Outcome {
	kind: "finished" | "error";
	messageIndex: number;
	text: string;
	title: string;
}

interface Showing {
	requestId: string | null;
	sessionId: string | null;
	at: number;
}

type DialogAnswer = { value: string } | { confirmed: boolean };

export class WatchService {
	private deps: WatchDeps;
	private now: () => number;
	private cursor = 0;
	private scheduled = false;
	private closed = false;
	private waiters = new Set<(p: WatchPending) => void>();
	private dismissed = new Set<string>();
	private outcomes = new Map<string, Outcome>(); // by session id
	private created = new Map<string, number>(); // request id → first seen
	private showingState: Showing | null = null;
	private lastShown: string[] = []; // most recent last
	private offs: (() => void)[];

	constructor(deps: WatchDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		const { registry, viewers } = deps;
		this.offs = [
			registry.onChange((m) => {
				if (m.type === "session_state" && m.state === "running") this.outcomes.delete(m.sessionId);
				this.refresh();
				this.changed();
			}),
			watchTurns(registry, (o, snap) => {
				if (o.kind === "needs_you" || viewers.watching()) return;
				this.outcomes.set(o.sessionId, { kind: o.kind, messageIndex: o.messageIndex, text: clip(o.text), title: sessionTitle(snap) });
				this.created.set(`${o.kind}:${o.sessionId}:${o.messageIndex}`, this.now());
				this.changed();
			}),
			viewers.onChange((watching) => {
				if (watching) this.outcomes.clear();
				this.changed();
			}),
		];
	}

	pending(): WatchPending {
		const present = this.refresh();
		const requests = this.deps.viewers.watching() ? [] : present.filter((r) => !this.dismissed.has(r.id)).sort((a, b) => a.createdAt - b.createdAt);
		return { cursor: this.cursor, requests, showing: this.showingState?.requestId ?? null, sessions: [] };
	}

	wait(since: number, maxMs = WAIT_MS): Promise<WatchPending> {
		if (this.cursor > since || this.closed) return Promise.resolve(this.pending());
		return new Promise((resolve) => {
			const done = (p: WatchPending) => {
				clearTimeout(timer);
				this.waiters.delete(done);
				resolve(p);
			};
			const timer = setTimeout(() => done(this.pending()), maxMs);
			this.waiters.add(done);
		});
	}

	showing(requestId: string | null, sessionId: string | null = null): void {
		const sid = sessionId ?? (requestId ? sessionOf(requestId) : null);
		const prev = this.showingState;
		this.showingState = requestId || sid ? { requestId, sessionId: sid, at: this.now() } : null;
		if (requestId) this.lastShown = [...this.lastShown.filter((id) => id !== requestId), requestId].slice(-LAST_SHOWN_MAX);
		if (prev?.requestId !== this.showingState?.requestId || prev?.sessionId !== this.showingState?.sessionId) this.changed();
	}

	dismiss(requestId: string): void {
		if (!this.refresh().some((r) => r.id === requestId) || this.dismissed.has(requestId)) return;
		this.dismissed.add(requestId);
		this.changed();
	}

	async answer(requestId: string, a: { option?: string; text?: string }): Promise<WatchAnswerResult> {
		const req = this.refresh().find((r) => r.id === requestId);
		if (!req) return { ok: false, reason: "gone" };
		if (req.kind !== "dialog") {
			if (a.text === undefined) return { ok: false, reason: "no_match", options: req.options };
			await this.prompt(req.sessionId, a.text);
			return { ok: true };
		}
		const answer = dialogAnswer(req, a);
		if (!answer) return { ok: false, reason: "no_match", options: req.options };
		const h = this.deps.registry.get(req.sessionId);
		if (!h) return { ok: false, reason: "gone" };
		const res = await h.command({ type: "dialog_response", id: requestId.slice(`dialog:${req.sessionId}:`.length), ...answer });
		this.changed();
		if (!res.ok) {
			this.deps.log?.(`watch: answer to ${requestId} failed: ${res.error ?? "unknown"}`);
			return { ok: false, reason: "gone" };
		}
		return { ok: true };
	}

	async prompt(sessionId: string, text: string): Promise<void> {
		await this.send(sessionId, { type: "prompt", text, mode: "send" });
		this.outcomes.delete(sessionId);
		this.changed();
	}

	async setModel(sessionId: string, provider: string, modelId: string): Promise<void> {
		await this.send(sessionId, { type: "set_model", provider, modelId });
	}

	async sessions(): Promise<WatchSession[]> {
		throw new Error("not yet");
	}

	async history(_sessionId: string, _before?: number, _limit?: number): Promise<{ turns: WatchTurn[]; total: number }> {
		throw new Error("not yet");
	}

	async models(_sessionId: string): Promise<{ current: { provider: string; id: string; name: string } | null; models: { provider: string; id: string; name: string }[] }> {
		throw new Error("not yet");
	}

	// Index 01's routing target (spec §10 step 3).
	currentTarget(): { requestId: string; sessionId: string } | null {
		const requests = this.pending().requests;
		const candidates = [this.showingState?.requestId, ...[...this.lastShown].reverse()];
		for (const id of candidates) {
			const r = id ? requests.find((x) => x.id === id) : undefined;
			if (r) return { requestId: r.id, sessionId: r.sessionId };
		}
		return null;
	}

	health(): { running: number; pending: number } {
		const running = this.deps.registry.all().filter((h) => h.kind === "rpc" && h.liveState() === "running").length;
		return { running, pending: this.pending().requests.length };
	}

	waiterCount(): number {
		return this.waiters.size;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const off of this.offs) off();
		const p = this.pending();
		for (const w of [...this.waiters]) w(p);
	}

	private async send(sessionId: string, cmd: AppCommand): Promise<void> {
		const h = await this.deps.registry.ensure(sessionId);
		const res = await h.command(cmd);
		if (!res.ok) throw new HttpError(409, res.error ?? `${cmd.type} failed`);
	}

	// Every request that exists now, before the viewer gate and dismissals, and
	// forgets state about requests that have ended.
	private refresh(): WatchRequest[] {
		const present = [...this.dialogRequests(), ...this.outcomeRequests()];
		const ids = new Set(present.map((r) => r.id));
		for (const id of this.dismissed) if (!ids.has(id)) this.dismissed.delete(id);
		for (const id of this.created.keys()) if (!ids.has(id)) this.created.delete(id);
		this.lastShown = this.lastShown.filter((id) => ids.has(id));
		if (this.showingState?.requestId && !ids.has(this.showingState.requestId)) this.showingState = null;
		return present;
	}

	private dialogRequests(): WatchRequest[] {
		const out: WatchRequest[] = [];
		for (const h of this.deps.registry.all()) {
			if (h.kind !== "rpc") continue;
			const snap = h.snapshot();
			if (snap.dialogs.length === 0) continue;
			const title = sessionTitle(snap);
			const tool = h.pendingTool?.()?.name ?? null;
			for (const d of snap.dialogs) {
				const id = `dialog:${h.sessionId}:${d.id}`;
				out.push({ id, kind: "dialog", sessionId: h.sessionId, sessionTitle: title, tool, message: dialogMessage(d), options: dialogOptions(d), method: d.method, createdAt: this.createdAt(id) });
			}
		}
		return out;
	}

	private outcomeRequests(): WatchRequest[] {
		return [...this.outcomes].map(([sessionId, o]) => {
			const id = `${o.kind}:${sessionId}:${o.messageIndex}`;
			return { id, kind: o.kind, sessionId, sessionTitle: o.title, tool: "question", message: o.text, options: [], method: null, createdAt: this.createdAt(id) };
		});
	}

	private createdAt(id: string): number {
		let t = this.created.get(id);
		if (t === undefined) {
			t = this.now();
			this.created.set(id, t);
		}
		return t;
	}

	// Coalesces a burst of changes into one cursor bump and one wake-up.
	private changed(): void {
		if (this.scheduled || this.closed) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (this.closed) return;
			this.cursor++;
			if (this.waiters.size === 0) return;
			const p = this.pending();
			for (const w of [...this.waiters]) w(p);
		});
	}
}

function dialogMessage(d: Dialog): string {
	return d.message ? `${d.title}\n${d.message}` : d.title;
}

function dialogOptions(d: Dialog): string[] {
	if (d.method === "select") return d.options ?? [];
	if (d.method === "confirm") return ["yes", "no"];
	return [];
}

// Spec §5's answer mapping for a dialog; null when the answer fits none of its options.
function dialogAnswer(req: WatchRequest, a: { option?: string; text?: string }): DialogAnswer | null {
	if (req.method === "input" || req.method === "editor") return a.text === undefined ? null : { value: a.text };
	let choice: string | null = null;
	if (a.option !== undefined) choice = req.options.includes(a.option) ? a.option : null;
	else if (a.text !== undefined) {
		const m = matchOption(a.text, req.options);
		choice = m.kind === "match" ? m.option : null;
	}
	if (choice === null) return null;
	return req.method === "confirm" ? { confirmed: choice === "yes" } : { value: choice };
}

function sessionOf(requestId: string): string | null {
	return requestId.split(":")[1] || null;
}

function clip(s: string): string {
	const t = s.trim();
	return t.length > MESSAGE_MAX ? `${t.slice(0, MESSAGE_MAX - 1)}…` : t;
}
