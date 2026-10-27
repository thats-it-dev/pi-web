// What the Pebble watch shows and answers (spec §4–§6). Queries are derived on
// demand from the live handles' pending dialogs plus the external ones in the
// QueryStore; a small record of turns that finished or errored while no app was
// open feeds the Notifier. The service also keeps the watch's skips and what it
// reports as on screen, and wakes long-pollers.

import type { IncomingHttpHeaders } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { LiveStats } from "../../shared/src/live-stats.ts";
import type { AppCommand, Dialog, DialogMethod, SessionStatus, Showing, WatchAnswerResult, WatchPending, WatchQuery, WatchSession, WatchStreamFrame, WatchTurn } from "../../shared/src/protocol.ts";
import { contentText } from "../../shared/src/reducer.ts";
import { matchOption } from "./answer-match.ts";
import { HttpError } from "./errors.ts";
import type { SessionHandle } from "./handle.ts";
import { dialogMessage, sessionTitle, type Viewers } from "./push-watch.ts";
import type { LastModelStore } from "./last-model.ts";
import { type ModelCatalog, resolveChoice } from "./model-catalog.ts";
import { QueryStore } from "./queries.ts";
import type { Registry } from "./registry.ts";
import { type FileSummary, readHistory, type SessionIndex } from "./sessions.ts";
import { watchTurns } from "./turns.ts";
import { closedSession, liveSession, turnsFrom } from "./watch-sessions.ts";

const MESSAGE_MAX = 240;
const WAIT_MS = 25_000;
const CLOSED_MAX = 20;
const HISTORY_LIMIT = 12;
const SPEED_TICK_MS = 1000;
const TEXT_TICK_MS = 250;
const TEXT_TAIL = 240;

export interface WatchDeps {
	registry: Registry;
	index: SessionIndex;
	viewers: Viewers;
	home: string;
	dataDir?: string; // where watch-archive.json lives (archiving is in memory only without it)
	catalog?: Pick<ModelCatalog, "get">; // with lastModel, picks the model a new session starts on (pi's own default if absent)
	lastModel?: LastModelStore;
	now?: () => number;
	log?: (m: string) => void;
}

interface Outcome {
	kind: "finished" | "error";
	messageIndex: number;
	text: string;
	title: string;
}

export interface TurnAlert {
	sessionId: string;
	kind: "finished" | "error";
	title: string;
	text: string;
}

interface ShowingState extends Showing {
	at: number;
}

// A pi dialog as the service tracks it: the query the watch sees, plus what answering needs.
interface DialogQuery extends WatchQuery {
	sessionId: string;
	method: DialogMethod;
}

// Live context and speed for one handle, fed by a stream tap that does not count as a viewer.
interface Tracked {
	live: LiveStats;
	off: () => void;
	tickAt: number; // when streaming last woke pollers
	textAt: number; // when a text tail last went to subscribers
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
	private subscribers = new Set<(f: WatchStreamFrame) => void>();
	private dismissed = new Set<string>();
	private outcomes = new Map<string, Outcome>(); // by session id
	private alertFns = new Set<(a: TurnAlert) => void>();
	private queryFns = new Set<(q: WatchQuery) => void>();
	private announced = new Set<string>(); // query ids already handed to queryFns, pruned to those still present
	private created = new Map<string, number>(); // query id → first seen
	private showingState: ShowingState | null = null;
	private offs: (() => void)[];
	private tracked = new Map<SessionHandle, Tracked>();
	private closedFiles: FileSummary[] = []; // the index as last read, newest first
	readonly queries: QueryStore;
	phone: string | null = null; // the last address a watch request came from (the phone, via the tailnet)

	notePhone(h: IncomingHttpHeaders, remote: string | undefined): void {
		const fwd = h["x-forwarded-for"];
		const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
		// Only an address: anything else in the header falls back to the socket's.
		const addr = (first && isIP(first) ? first : "") || remote?.replace(/^::ffff:/, "");
		if (addr) this.phone = addr;
	}

	private archived: Record<string, number> = {};

	constructor(deps: WatchDeps) {
		this.deps = deps;
		this.archived = this.loadArchive();
		this.now = deps.now ?? Date.now;
		const { registry, viewers } = deps;
		this.queries = new QueryStore({ now: this.now, onChange: () => this.changed() });
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
				this.changed();
				const alert = this.alertOf(o.sessionId);
				if (alert) for (const fn of [...this.alertFns]) fn(alert);
			}),
			viewers.onChange((watching) => {
				if (watching) this.outcomes.clear();
				this.changed();
			}),
		];
		void this.loadClosed();
	}

	pending(): WatchPending {
		const queries = this.visible();
		const showing = this.showingState ? { queryId: this.showingState.queryId, sessionId: this.showingState.sessionId } : null;
		return { cursor: this.cursor, queries, showing, sessions: this.sessionList(queries) };
	}

	// Turns that finished or errored while no app was open, for the Notifier.
	turnAlerts(): TurnAlert[] {
		return [...this.outcomes.keys()].map((id) => this.alertOf(id)!);
	}

	onTurnAlert(fn: (a: TurnAlert) => void): () => void {
		this.alertFns.add(fn);
		return () => {
			this.alertFns.delete(fn);
		};
	}

	// An aborted signal drops the waiter and leaves the promise pending, so only abort for a caller that has gone.
	wait(since: number, maxMs = WAIT_MS, signal?: AbortSignal): Promise<WatchPending> {
		if (this.cursor !== since || this.closed) return Promise.resolve(this.pending());
		if (signal?.aborted) return new Promise(() => {});
		return new Promise((resolve) => {
			const done = (p: WatchPending) => {
				clearTimeout(timer);
				this.waiters.delete(done);
				signal?.removeEventListener("abort", drop);
				resolve(p);
			};
			const drop = () => {
				clearTimeout(timer);
				this.waiters.delete(done);
			};
			const timer = setTimeout(() => done(this.pending()), maxMs);
			this.waiters.add(done);
			signal?.addEventListener("abort", drop, { once: true });
		});
	}

	showing(w: Showing): void {
		const { queryId } = w;
		const sid = w.sessionId ?? (queryId ? sessionOf(queryId) : null);
		const prev = this.showingState;
		this.showingState = queryId || sid ? { queryId, sessionId: sid, at: this.now() } : null;
		if (queryId) {
			this.queries.markDelivered(queryId);
		}
		if (prev?.queryId !== this.showingState?.queryId || prev?.sessionId !== this.showingState?.sessionId) this.changed();
		const next = this.showingState?.sessionId ?? null;
		if (next && next !== (prev?.sessionId ?? null)) {
			const h = this.deps.registry.get(next);
			if (h?.kind === "rpc") {
				const conv = h.snapshot().conv;
				if (conv.streaming) {
					const t = this.tracked.get(h);
					if (this.emitText(next, contentText(conv.partial?.content ?? ""), true) && t) t.textAt = this.now();
				}
			}
		}
	}

	// Called once for each query the watch is offered (external ones at once, pi dialogs when
	// no app holds them back), from the next change after it appears. A throwing listener is logged.
	onNewQuery(fn: (q: WatchQuery) => void): () => void {
		this.queryFns.add(fn);
		return () => {
			this.queryFns.delete(fn);
		};
	}

	// Nothing is sent on subscribe; the caller sends pending() itself.
	subscribe(fn: (f: WatchStreamFrame) => void): () => void {
		this.subscribers.add(fn);
		return () => {
			this.subscribers.delete(fn);
		};
	}

	subscriberCount(): number {
		return this.subscribers.size;
	}

	// What the watch last reported on screen, or null.
	onScreen(): Showing | null {
		this.refresh();
		return this.showingState ? { queryId: this.showingState.queryId, sessionId: this.showingState.sessionId } : null;
	}

	// A pi query is only hidden from the watch (the dialog stays pending in its handle); an external one ends.
	skip(queryId: string): void {
		if (this.queries.resolve(queryId, { kind: "skip" })) return;
		if (!this.refresh().some((r) => r.id === queryId) || this.dismissed.has(queryId)) return;
		this.dismissed.add(queryId);
		this.changed();
	}

	async answer(queryId: string, a: { option?: string; text?: string }): Promise<WatchAnswerResult> {
		const ext = this.queries.external().find((q) => q.id === queryId);
		if (ext) {
			if (a.option !== undefined) {
				if (!ext.options.includes(a.option)) return { ok: false, reason: "no_match", options: ext.options };
				return this.queries.resolve(queryId, { kind: "option", option: a.option }) ? { ok: true } : { ok: false, reason: "gone" };
			}
			if (a.text === undefined) return { ok: false, reason: "no_match", options: ext.options };
			return this.queries.resolve(queryId, { kind: "ring-answer", text: a.text }) ? { ok: true } : { ok: false, reason: "gone" };
		}
		const req = this.dialogQueries().find((r) => r.id === queryId);
		if (!req) return { ok: false, reason: "gone" };
		const answer = dialogAnswer(req, a);
		if (!answer) return { ok: false, reason: "no_match", options: req.options };
		const h = this.deps.registry.get(req.sessionId);
		if (!h) return { ok: false, reason: "gone" };
		const res = await h.command({ type: "dialog_response", id: queryId.slice(`dialog:${req.sessionId}:`.length), ...answer });
		this.changed();
		if (!res.ok) {
			this.deps.log?.(`watch: answer to ${queryId} failed: ${res.error ?? "unknown"}`);
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

	async abort(sessionId: string): Promise<WatchAnswerResult> {
		const h = this.deps.registry.get(sessionId);
		if (!h) return { ok: false, reason: "gone" };
		await this.send(h, { type: "abort" });
		return { ok: true };
	}

	// Hides a session from the watch's list until it is active again.
	archive(sessionId: string): void {
		this.archived[sessionId] = this.now();
		const file = this.archiveFile();
		if (file) {
			try {
				writeFileSync(file, JSON.stringify(this.archived));
			} catch (e) {
				this.deps.log?.(`watch: archive: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		this.changed();
	}

	private archiveFile(): string | null {
		return this.deps.dataDir ? join(this.deps.dataDir, "watch-archive.json") : null;
	}

	private loadArchive(): Record<string, number> {
		const file = this.archiveFile();
		if (!file) return {};
		try {
			const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			const out: Record<string, number> = {};
			for (const [k, v] of Object.entries(j)) if (typeof v === "number") out[k] = v;
			return out;
		} catch {
			return {};
		}
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

	// A short line for the watch to flash, sent to stream subscribers.
	notice(text: string): void {
		for (const s of [...this.subscribers]) s({ type: "notice", text });
	}

	// A voice note with nothing to answer starts a session in ~/pebble (spec §10).
	async startRingSession(text: string): Promise<string> {
		const cwd = join(this.deps.home, "pebble");
		mkdirSync(cwd, { recursive: true });
		const h = await this.deps.registry.create(cwd, this.deps.catalog ? resolveChoice(await this.deps.catalog.get(), this.deps.lastModel?.get() ?? null) : null);
		await this.send(h, { type: "prompt", text, mode: "send" });
		this.deps.log?.(`index: started session ${h.sessionId} in ~/pebble`);
		return h.sessionId;
	}

	health(): { running: number; pending: number } {
		const running = this.deps.registry.all().filter((h) => h.kind === "rpc" && h.liveState() === "running").length;
		return { running, pending: this.pending().queries.length };
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
		this.subscribers.clear();
		this.alertFns.clear();
		this.queries.close();
		const p = this.pending();
		for (const w of [...this.waiters]) w(p);
	}

	private async send(h: SessionHandle, cmd: AppCommand): Promise<void> {
		const res = await h.command(cmd);
		if (!res.ok) throw new HttpError(409, res.error ?? `${cmd.type} failed`);
	}

	// Every query that exists now, before the viewer gate and skips, and
	// forgets state about queries that have ended.
	private refresh(): WatchQuery[] {
		this.track();
		const present = [...this.dialogQueries(), ...this.queries.external()];
		const ids = new Set(present.map((r) => r.id));
		for (const id of this.dismissed) if (!ids.has(id)) this.dismissed.delete(id);
		for (const id of this.created.keys()) if (!ids.has(id)) this.created.delete(id);
		if (this.showingState?.queryId && !ids.has(this.showingState.queryId)) this.showingState = null;
		return present;
	}

	// What the watch is offered: pi dialogs are held while an app is open or after a skip; external ones are not.
	private visible(present: WatchQuery[] = this.refresh()): WatchQuery[] {
		const watching = this.deps.viewers.watching();
		return present
			.filter((q) => q.source !== "pi" || (!watching && !this.dismissed.has(q.id)))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(({ id, source, sessionId, label, text, options, createdAt }) => ({ id, source, sessionId, label, text, options, createdAt }));
	}

	private alertOf(sessionId: string): TurnAlert | null {
		const o = this.outcomes.get(sessionId);
		return o ? { sessionId, kind: o.kind, title: o.title, text: o.text } : null;
	}

	// Waiting sessions first, then most recently active; closed ones are capped.
	private sessionList(queries: WatchQuery[] = this.visible()): WatchSession[] {
		this.track();
		const handles = this.deps.registry.all().sort((a, b) => b.lastActive - a.lastActive);
		const liveIds = new Set(handles.map((h) => h.sessionId));
		const closed = this.closedFiles.filter((s) => !liveIds.has(s.id)).slice(0, CLOSED_MAX);
		const asking = new Set(queries.map((q) => q.sessionId));
		const all = [...handles.map((h) => liveSession(h, this.tracked.get(h)?.live)), ...closed.map(closedSession)];
		const shown = all.filter((s) => this.archived[s.id] === undefined || s.updatedAt > this.archived[s.id]!);
		all.length = 0;
		all.push(...shown);
		for (const s of all) s.status = this.statusOf(s, asking.has(s.id));
		const rank = (s: WatchSession) => (s.status === "waiting" ? 0 : 1);
		return all.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
	}

	private statusOf(s: WatchSession, asked: boolean): SessionStatus {
		if (asked || s.state === "needs_you") return "waiting";
		if (s.state === "error" || this.outcomes.get(s.id)?.kind === "error") return "error";
		return s.state === "running" ? "running" : "done";
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
			const t: Tracked = { live, off: () => {}, tickAt: -Infinity, textAt: -Infinity };
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
					if (shown && m.event.type === "message_update" && this.now() - t.textAt >= TEXT_TICK_MS) {
						if (this.emitText(h.sessionId, contentText(h.snapshot().conv.partial?.content ?? ""), true)) t.textAt = this.now();
					} else if (shown && m.event.type === "message_end" && m.event.message?.role === "assistant") {
						t.textAt = -Infinity;
						this.emitText(h.sessionId, contentText(m.event.message?.content ?? ""), false);
					}
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

	private dialogQueries(): DialogQuery[] {
		const out: DialogQuery[] = [];
		for (const h of this.deps.registry.all()) {
			if (h.kind !== "rpc") continue;
			const snap = h.snapshot();
			if (snap.dialogs.length === 0) continue;
			const label = `pi · ${sessionTitle(snap)}`;
			for (const d of snap.dialogs) {
				const id = `dialog:${h.sessionId}:${d.id}`;
				out.push({ id, source: "pi", sessionId: h.sessionId, label, text: dialogMessage(d), options: dialogOptions(d), createdAt: this.createdAt(id), method: d.method });
			}
		}
		return out;
	}

	private createdAt(id: string): number {
		let t = this.created.get(id);
		if (t === undefined) {
			t = this.now();
			this.created.set(id, t);
		}
		return t;
	}

	// An empty tail (thinking, a tool call) is not sent: it would blank the watch's last reply.
	// Returns whether a frame went out.
	private emitText(sessionId: string, text: string, streaming: boolean): boolean {
		const tail = text.trim().slice(-TEXT_TAIL);
		if (!tail) return false;
		const frame: WatchStreamFrame = { type: "text", sessionId, text: tail, streaming };
		for (const s of [...this.subscribers]) s(frame);
		return true;
	}

	private announceQueries(): void {
		if (this.queryFns.size === 0) return;
		const all = this.refresh();
		const present = new Set(all.map((q) => q.id));
		for (const id of this.announced) if (!present.has(id)) this.announced.delete(id);
		for (const q of this.visible(all)) {
			if (this.announced.has(q.id)) continue;
			this.announced.add(q.id);
			for (const fn of [...this.queryFns]) {
				try {
					fn(q);
				} catch (err) {
					this.deps.log?.(`watch: query listener: ${(err as Error).message}`);
				}
			}
		}
	}

	// Coalesces a burst of changes into one cursor bump and one wake-up.
	private changed(): void {
		if (this.scheduled || this.closed) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (this.closed) return;
			this.cursor++;
			this.announceQueries();
			if (this.waiters.size + this.subscribers.size === 0) return;
			const p = this.pending();
			for (const s of [...this.subscribers]) s({ type: "pending", ...p });
			for (const w of [...this.waiters]) w(p);
		});
	}
}

function dialogOptions(d: Dialog): string[] {
	if (d.method === "select") return d.options ?? [];
	if (d.method === "confirm") return ["yes", "no"];
	return [];
}

// Spec §5's answer mapping for a dialog; null when the answer fits none of its options.
function dialogAnswer(req: DialogQuery, a: { option?: string; text?: string }): DialogAnswer | null {
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

function sessionOf(queryId: string): string | null {
	const [kind, sid] = queryId.split(":");
	return kind === "dialog" ? sid || null : null;
}

function clip(s: string): string {
	const t = s.trim();
	return t.length > MESSAGE_MAX ? `${t.slice(0, MESSAGE_MAX - 1)}…` : t;
}
