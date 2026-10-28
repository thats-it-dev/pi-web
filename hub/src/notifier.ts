// Web Push alerts (push + TL;DR spec): a pi turn finished, needs Michael or errored, or
// ring-profile raised a question. The phone shows the push and mirrors it to the watch.
// Titles are short (24 characters fit the watch's notification header): the agent's TL;DR
// title for a finished turn, else "<project> · <event>". A session someone is looking at
// in the app gets no push for its turns; its dialogs wait until the app leaves it.
// Every entry point catches and logs: callers are synchronous listeners and must not see a throw.

import { basename } from "node:path";
import type { Dialog, PushPayload, Snapshot, WatchQuery } from "../../shared/src/protocol.ts";
import { parseTldr, stripTldr } from "../../shared/src/tldr.ts";
import { clipText, dialogMessage } from "./push-watch.ts";
import type { TurnOutcome } from "./turns.ts";
import { dialogQueryId, type RingAlert } from "./watch.ts";

export interface NotifierDeps {
	enabled: boolean;
	push: (p: PushPayload) => Promise<boolean>;
	viewing: (sessionId: string) => boolean; // an app is showing this session
	markDelivered: (queryId: string) => void;
	isPending: (queryId: string) => boolean; // still unanswered (stuck reminders)
	stuckMs?: number;
	log?: (m: string) => void;
	setTimer?: (fn: () => void, ms: number) => unknown;
}

const TITLE_MAX = 24;
const BODY_MAX = 160;
const VIEW_GRACE_MS = 5000; // a stream that reconnects by itself is gone for a moment; don't flush on that
const MISS_TITLE = "Didn't catch that";

// "<project> · <event>", the project cut (with "…") so the whole fits TITLE_MAX.
export function shortTitle(project: string, event: "done" | "approve?" | "question" | "error" | "waiting"): string {
	const suffix = ` · ${event}`;
	const room = TITLE_MAX - suffix.length;
	const p = project.trim() || "pi";
	return `${p.length > room ? `${p.slice(0, room - 1)}…` : p}${suffix}`;
}

export class Notifier {
	private deps: NotifierDeps;
	private scheduled = new Set<string>(); // query ids that already have a reminder timer
	private graceTokens = new Map<string, object>(); // sessions whose viewing just ended, by pending flush
	private held = new Map<string, { sessionId: string; dialog: Dialog; snap: Snapshot }>(); // by dialog query id

	constructor(deps: NotifierDeps) {
		this.deps = deps;
	}

	// A finished or error turn from watchPush. finished: the TL;DR, else the start of the reply;
	// error: the error text. needs_you is dialog()'s job, once per dialog.
	async turn(o: TurnOutcome, snap: Snapshot): Promise<void> {
		try {
			if (!this.deps.enabled || o.kind === "needs_you" || this.deps.viewing(o.sessionId)) return;
			const project = basename(snap.cwd);
			if (o.kind === "error") {
				await this.send({ sessionId: o.sessionId, title: shortTitle(project, "error"), kind: "error" }, o.text, "The model returned an error.");
				return;
			}
			const tldr = parseTldr(o.text);
			const title = tldr?.title ? clipText(tldr.title, TITLE_MAX) : shortTitle(project, "done");
			await this.send({ sessionId: o.sessionId, title, kind: "finished" }, tldr?.summary ?? stripTldr(o.text), "(no text)");
		} catch (err) {
			this.log(`notifier: turn ${o.sessionId}: ${(err as Error).message}`);
		}
	}

	// A pi dialog that just appeared (WatchService.onDialog). Held while its session is viewed:
	// the app shows it, and viewingEnded pushes it if it is still unanswered.
	async dialog(sessionId: string, dialog: Dialog, snap: Snapshot): Promise<void> {
		const id = dialogQueryId(sessionId, dialog);
		try {
			if (!this.deps.enabled) return;
			if (this.deps.viewing(sessionId)) {
				this.held.set(id, { sessionId, dialog, snap });
				return;
			}
			await this.pushDialog(sessionId, dialog, snap);
		} catch (err) {
			this.log(`notifier: dialog ${id}: ${(err as Error).message}`);
		}
	}

	// A viewer count crossed zero for the session. Ending is flushed after a grace period and
	// cancelled if the session is viewed again before then (the PWA's stream reconnecting).
	viewingChanged(sessionId: string, viewing: boolean): void {
		if (viewing) {
			this.graceTokens.delete(sessionId);
			return;
		}
		const token = {};
		this.graceTokens.set(sessionId, token);
		const fire = () => {
			if (this.graceTokens.get(sessionId) !== token) return;
			this.graceTokens.delete(sessionId);
			void this.viewingEnded(sessionId);
		};
		const timer = (this.deps.setTimer ?? setTimeout)(fire, VIEW_GRACE_MS) as { unref?: () => void } | undefined;
		timer?.unref?.();
	}

	// The app stopped showing the session: push its held dialogs that are still pending, drop the rest.
	async viewingEnded(sessionId: string): Promise<void> {
		for (const [id, h] of [...this.held]) {
			if (h.sessionId !== sessionId) continue;
			this.held.delete(id);
			try {
				if (this.deps.enabled && this.deps.isPending(id)) await this.pushDialog(h.sessionId, h.dialog, h.snap);
			} catch (err) {
				this.log(`notifier: held dialog ${id}: ${(err as Error).message}`);
			}
		}
	}

	// The closed-app ring path answers only dialogs that were alerted, so a pushed one is marked.
	private async pushDialog(sessionId: string, dialog: Dialog, snap: Snapshot): Promise<void> {
		const project = basename(snap.cwd);
		const body = dialogMessage(dialog);
		const id = dialogQueryId(sessionId, dialog);
		if (await this.send({ sessionId, title: shortTitle(project, dialog.method === "confirm" ? "approve?" : "question"), kind: "needs_you", tag: id }, body, "Needs you.")) {
			this.deps.markDelivered(id);
			this.scheduleStuck(id, { sessionId, title: shortTitle(project, "waiting"), kind: "needs_you", tag: id }, body, true);
		}
	}

	// One reminder per query id, stuckMs after its push, if it is still unanswered. A dialog whose
	// session is being viewed at that point gets none (the app shows it) and is not rescheduled.
	private scheduleStuck(id: string, p: PushPayload, body: string, dialog: boolean): void {
		if (this.scheduled.has(id)) return;
		this.scheduled.add(id);
		const fire = () => {
			try {
				if (!this.deps.enabled || !this.deps.isPending(id) || (dialog && this.deps.viewing(p.sessionId))) return;
				const b = clipText(body, BODY_MAX);
				this.send(p, b ? `Still waiting: ${b}` : "Still waiting", "Still waiting").catch((err) => this.log(`notifier: waiting ${id}: ${(err as Error).message}`));
			} catch (err) {
				this.log(`notifier: waiting ${id}: ${(err as Error).message}`);
			}
		};
		const timer = (this.deps.setTimer ?? setTimeout)(fire, this.deps.stuckMs ?? 900_000) as { unref?: () => void } | undefined;
		timer?.unref?.();
	}

	// A ring-profile question. pi dialogs alert through dialog(), so they're ignored here.
	async query(q: WatchQuery): Promise<void> {
		try {
			if (!this.deps.enabled || q.source !== "ring-profile") return;
			const sessionId = q.sessionId ?? "";
			if (await this.send({ sessionId, title: shortTitle("ring", "question"), kind: "query", tag: q.id }, q.text, q.label || "Question waiting")) {
				this.deps.markDelivered(q.id);
				this.scheduleStuck(q.id, { sessionId, title: shortTitle("ring", "waiting"), kind: "query", tag: q.id }, q.text, false);
			}
		} catch (err) {
			this.log(`notifier: query ${q.id}: ${(err as Error).message}`);
		}
	}

	// What a ring note did to a pi dialog while the app was closed (spec §5): one alert.
	// A miss names the dialog and its options; an answer is the receipt for an approval given blind.
	async ringAlert(a: RingAlert): Promise<void> {
		try {
			if (!this.deps.enabled) return;
			const q = a.query;
			const title = a.kind === "miss" ? MISS_TITLE : clipText(`Answered: ${a.option}`, TITLE_MAX);
			const body = a.kind === "miss" ? `${q.label}: ${q.options.join(", ")}` : q.label;
			await this.send({ sessionId: q.sessionId ?? "", title, kind: "query", tag: q.id }, body, q.label || "Question waiting");
		} catch (err) {
			this.log(`notifier: ring ${a.kind} ${a.query.id}: ${(err as Error).message}`);
		}
	}

	// The body is clipped to BODY_MAX; an empty one becomes the fallback, so no push is bodiless.
	// True when the push went out.
	private send(p: PushPayload, body: string, fallback: string): Promise<boolean> {
		return this.deps.push({ ...p, body: clipText(body, BODY_MAX) || fallback });
	}

	private log(m: string): void {
		try {
			(this.deps.log ?? ((x) => console.log(x)))(m);
		} catch {}
	}
}
