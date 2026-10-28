// Web Push alerts (push + TL;DR spec): a pi turn finished, needs Michael or errored, or
// ring-profile raised a question. The phone shows the push and mirrors it to the watch.
// Titles are short (24 characters fit the watch's notification header): the agent's TL;DR
// title for a finished turn, else "<project> · <event>". A session someone is looking at
// in the app gets no push for its turns.
// Every entry point catches and logs: callers are synchronous listeners and must not see a throw.

import { basename } from "node:path";
import type { PushPayload, Snapshot, WatchQuery } from "../../shared/src/protocol.ts";
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

	constructor(deps: NotifierDeps) {
		this.deps = deps;
	}

	// A turn outcome from watchPush. finished: the TL;DR, else the start of the reply;
	// needs_you: what the dialog asks; error: the error text.
	async turn(o: TurnOutcome, snap: Snapshot): Promise<void> {
		try {
			if (!this.deps.enabled || this.deps.viewing(o.sessionId)) return;
			const project = basename(snap.cwd);
			if (o.kind === "needs_you") {
				const d = snap.dialogs[0];
				const title = shortTitle(project, d?.method === "confirm" ? "approve?" : "question");
				const sent = await this.send({ sessionId: o.sessionId, title, kind: "needs_you" }, d ? dialogMessage(d) : "");
				// The closed-app ring path answers only dialogs that were alerted.
				if (sent && d) this.deps.markDelivered(dialogQueryId(o.sessionId, d));
				return;
			}
			if (o.kind === "error") {
				await this.send({ sessionId: o.sessionId, title: shortTitle(project, "error"), kind: "error" }, o.text);
				return;
			}
			const tldr = parseTldr(o.text);
			const title = tldr?.title ? clipText(tldr.title, TITLE_MAX) : shortTitle(project, "done");
			await this.send({ sessionId: o.sessionId, title, kind: "finished" }, tldr?.summary ?? stripTldr(o.text));
		} catch (err) {
			this.log(`notifier: turn ${o.sessionId}: ${(err as Error).message}`);
		}
	}

	// A ring-profile question. pi dialogs alert through turn (needs_you), so they're ignored here.
	async query(q: WatchQuery): Promise<void> {
		try {
			if (!this.deps.enabled || q.source !== "ring-profile") return;
			if (await this.send({ sessionId: q.sessionId ?? "", title: shortTitle("ring", "question"), kind: "query" }, q.text)) this.deps.markDelivered(q.id);
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
			await this.send({ sessionId: q.sessionId ?? "", title, kind: "query" }, body);
		} catch (err) {
			this.log(`notifier: ring ${a.kind} ${a.query.id}: ${(err as Error).message}`);
		}
	}

	// The body is clipped to BODY_MAX and left out when empty. True when the push went out.
	private send(p: PushPayload, body: string): Promise<boolean> {
		const b = clipText(body, BODY_MAX);
		return this.deps.push(b ? { ...p, body: b } : p);
	}

	private log(m: string): void {
		try {
			(this.deps.log ?? ((x) => console.log(x)))(m);
		} catch {}
	}
}
