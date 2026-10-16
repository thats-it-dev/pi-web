// What the Pebble watch shows and answers (spec §4, §5). Requests are derived
// on demand from the live handles' pending dialogs plus a small record of turns
// that finished or errored while no app was open. The service also keeps the
// watch's dismissals and what it reports as on screen, and wakes long-pollers.

import { LiveStats } from "../../shared/src/live-stats.ts";
import type { AppCommand, Dialog, WatchAnswerResult, WatchPending, WatchRequest, WatchSession, WatchTurn } from "../../shared/src/protocol.ts";
import { matchOption } from "./answer-match.ts";
import { HttpError } from "./errors.ts";
import type { SessionHandle } from "./handle.ts";
import { sessionTitle, type Viewers } from "./push-watch.ts";
import type { Registry } from "./registry.ts";
import { type FileSummary, readHistory, type SessionIndex } from "./sessions.ts";
import { watchTurns } from "./turns.ts";
import { closedSession, liveSession, turnsFrom } from "./watch-sessions.ts";

const MESSAGE_MAX = 240;
const LAST_SHOWN_MAX = 10;
const WAIT_MS = 25_000;
const CLOSED_MAX = 20;
const HISTORY_LIMIT = 12;
const SPEED_TICK_MS = 1000;

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

// Live context and speed for one handle, fed by a stream tap that does not count as a viewer.
interface Tracked {
	live: LiveStats;
	off: () => void;
	tickAt: number; // when streaming last woke pollers
}

type DialogAnswer = { value: string } | { confirmed: boolean };
type ModelRow = { provider: string; id: string; name: string };

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
	private tracked = new Map<SessionHandle, Tracked>();
	private closedFiles: FileSummary[] = []; // the index as last read, newest first

	constructor(deps: WatchDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		const { registry, viewers } = deps;
		this.offs = [
			registry.onChange((m) => {
				if (m.type === "session_state" && m.state === "running") this.outcomes.delete(m.sessionId);
				this.refresh();
				this.changed();
				// A session that closed or appeared may move between the live and closed lists.
				if (m.type === "session_list_changed" || !m.live) void this.loadClosed();
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
		void this.loadClosed();
	}

	pending(): WatchPending {
		const present = this.refresh();
		const requests = this.deps.viewers.watching() ? [] : present.filter((r) => !this.dismissed.has(r.id)).sort((a, b) => a.createdAt - b.createdAt);
		return { cursor: this.cursor, requests, showing: this.showingState?.requestId ?? null, sessions: this.sessionList() };
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
			return this.prompt(req.sessionId, a.text);
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

	// Gone when no handle is live and no file can reopen the session; other failures throw.
	async prompt(sessionId: string, text: string): Promise<WatchAnswerResult> {
		// Only the outcome this prompt answers ends; a fast reply's new one stays.
		const answered = this.outcomes.get(sessionId);
		let h: SessionHandle;
		try {
			h = await this.deps.registry.ensure(sessionId);
		} catch (e) {
			if (e instanceof HttpError && e.status === 404) return { ok: false, reason: "gone" };
			throw e;
		}
		await this.send(h, { type: "prompt", text, mode: "send" });
		if (answered && this.outcomes.get(sessionId) === answered) this.outcomes.delete(sessionId);
		this.changed();
		return { ok: true };
	}

	async setModel(sessionId: string, provider: string, modelId: string): Promise<void> {
		await this.send(await this.deps.registry.ensure(sessionId), { type: "set_model", provider, modelId });
	}

	async sessions(): Promise<WatchSession[]> {
		await this.loadClosed();
		return this.sessionList();
	}

	async history(sessionId: string, before?: number, limit = HISTORY_LIMIT): Promise<{ turns: WatchTurn[]; total: number }> {
		const h = this.deps.registry.get(sessionId);
		let all: WatchTurn[];
		if (h) all = turnsFrom(h.snapshot().conv.messages, h.snapshot().conv.tools);
		else {
			const file = await this.deps.index.find(sessionId);
			if (!file) throw new HttpError(404, "Session not found");
			all = turnsFrom(await readHistory(file.file), {});
		}
		const end = before === undefined ? all.length : Math.max(0, Math.min(before, all.length));
		return { turns: all.slice(Math.max(0, end - limit), end), total: all.length };
	}

	async models(sessionId: string): Promise<{ current: ModelRow | null; models: ModelRow[] }> {
		const h = this.deps.registry.get(sessionId);
		if (!h) throw new HttpError(404, "Session not found");
		const snap = h.snapshot();
		const row = (m: ModelRow): ModelRow => ({ provider: m.provider, id: m.id, name: m.name });
		return { current: snap.state.model ? row(snap.state.model) : null, models: snap.models.map(row) };
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
		for (const t of this.tracked.values()) t.off();
		this.tracked.clear();
		const p = this.pending();
		for (const w of [...this.waiters]) w(p);
	}

	private async send(h: SessionHandle, cmd: AppCommand): Promise<void> {
		const res = await h.command(cmd);
		if (!res.ok) throw new HttpError(409, res.error ?? `${cmd.type} failed`);
	}

	// Every request that exists now, before the viewer gate and dismissals, and
	// forgets state about requests that have ended.
	private refresh(): WatchRequest[] {
		this.track();
		const present = [...this.dialogRequests(), ...this.outcomeRequests()];
		const ids = new Set(present.map((r) => r.id));
		for (const id of this.dismissed) if (!ids.has(id)) this.dismissed.delete(id);
		for (const id of this.created.keys()) if (!ids.has(id)) this.created.delete(id);
		this.lastShown = this.lastShown.filter((id) => ids.has(id));
		if (this.showingState?.requestId && !ids.has(this.showingState.requestId)) this.showingState = null;
		return present;
	}

	// Live sessions (most recently active first), then the most recent closed ones.
	private sessionList(): WatchSession[] {
		this.track();
		const handles = this.deps.registry.all().sort((a, b) => b.lastActive - a.lastActive);
		const liveIds = new Set(handles.map((h) => h.sessionId));
		const closed = this.closedFiles.filter((s) => !liveIds.has(s.id)).slice(0, CLOSED_MAX);
		return [...handles.map((h) => liveSession(h, this.tracked.get(h)?.live)), ...closed.map(closedSession)];
	}

	// Starts observing rpc handles seen for the first time; forgets ones the registry dropped.
	private track(): void {
		if (this.closed) return;
		const handles = this.deps.registry.all().filter((h) => h.kind === "rpc");
		for (const [h, t] of this.tracked) if (!handles.includes(h)) this.untrack(h, t);
		for (const h of handles) {
			if (this.tracked.has(h)) continue;
			const snap = h.snapshot();
			const live = new LiveStats(this.now);
			live.reset(snap.stats, snap.conv.streaming);
			const t: Tracked = { live, off: () => {}, tickAt: -Infinity };
			this.tracked.set(h, t);
			t.off = h.observe((m) => {
				if (m.type === "handle_gone") return this.untrack(h, t);
				const shown = this.showingState?.sessionId === h.sessionId;
				if (m.type === "event") {
					live.onEvent(m.event);
					// Wakes pollers so the toolbar's t/s moves, at most once a second.
					if (shown && m.event.type === "message_update" && this.now() - t.tickAt >= SPEED_TICK_MS) {
						t.tickAt = this.now();
						this.changed();
					} else if (shown && m.event.type === "message_end") this.changed();
				} else if (m.type === "meta" || m.type === "snapshot") {
					live.onStats(m.type === "meta" ? m.stats : m.snapshot.stats);
					if (shown) this.changed();
				}
			});
		}
	}

	private untrack(h: SessionHandle, t: Tracked): void {
		t.off();
		if (this.tracked.get(h) === t) this.tracked.delete(h);
	}

	// Rereads the session index (cached per file); wakes pollers when the closed list moved.
	private async loadClosed(): Promise<void> {
		let files: FileSummary[];
		try {
			files = await this.deps.index.list();
		} catch (e) {
			this.deps.log?.(`watch: session index: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		const key = (l: FileSummary[]) => l.map((s) => `${s.id}@${s.updatedAt}`).join(",");
		const moved = key(files) !== key(this.closedFiles);
		this.closedFiles = files;
		if (moved) this.changed();
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
