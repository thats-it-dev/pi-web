// Decides when a session deserves a push (spec §5.5): a run finished, a dialog
// is waiting, or a run ended in an error, and no app is open anywhere to see
// it. Headless sessions only: someone running a terminal session is at the terminal.

import { basename } from "node:path";
import type { Dialog, PushPayload, Snapshot } from "../../shared/src/protocol.ts";
import { contentText } from "../../shared/src/reducer.ts";
import type { Registry } from "./registry.ts";
import { watchTurns } from "./turns.ts";

const TITLE_MAX = 60;
const MESSAGE_MAX = 240;
const BODY_MAX = 160;

// Apps currently open and in front of someone. Each holds the events stream
// only while it's visible, so a stream counts as a viewer.
export class Viewers {
	private count = 0;
	private listeners = new Set<(watching: boolean) => void>();

	add(): () => void {
		if (++this.count === 1) this.emit(true);
		let left = false;
		return () => {
			if (left) return;
			left = true;
			if (--this.count === 0) this.emit(false);
		};
	}

	// Fired when the count crosses zero either way.
	onChange(fn: (watching: boolean) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	private emit(watching: boolean): void {
		for (const fn of [...this.listeners]) fn(watching);
	}

	watching(): boolean {
		return this.count > 0;
	}
}

export function watchPush(registry: Pick<Registry, "onChange" | "get">, send: (p: PushPayload) => void, viewers?: Pick<Viewers, "watching">): () => void {
	return watchTurns(registry, (o, snap) => {
		if (viewers?.watching()) return;
		const p: PushPayload = { sessionId: o.sessionId, title: sessionTitle(snap), kind: o.kind };
		// needs_you: what the dialog asks; finished: the start of the reply; error: the error text.
		const detail = o.kind === "needs_you" ? (snap.dialogs[0] ? dialogMessage(snap.dialogs[0]) : "") : o.text;
		const body = clipText(detail, BODY_MAX);
		if (body) p.body = body;
		send(p);
	});
}

// A pi dialog as one block of text: its title, then its message.
export function dialogMessage(d: Dialog): string {
	return clipText(d.message ? `${d.title}\n${d.message}` : d.title, MESSAGE_MAX);
}

export function clipText(s: string, max: number): string {
	const t = s.trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// What the sidebar calls the session: its name, else the first prompt's first line, else its folder.
export function sessionTitle(snap: Snapshot): string {
	const name = snap.state?.sessionName?.trim();
	if (name) return clip(name);
	const first = snap.conv.messages.find((m) => m.role === "user");
	const line = first ? (contentText(first.content).trim().split("\n")[0] ?? "") : "";
	return clip(line.trim() || basename(snap.cwd) || "pi");
}

function clip(s: string): string {
	return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s;
}
