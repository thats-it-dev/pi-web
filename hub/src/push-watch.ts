// Turn outcomes for push (spec §5.5): a run finished, a dialog is waiting, or a
// run ended in an error. Headless sessions only: someone running a terminal
// session is at the terminal. Also tracks which apps are open and on which session.

import { basename } from "node:path";
import type { Dialog, Snapshot } from "../../shared/src/protocol.ts";
import { contentText } from "../../shared/src/reducer.ts";
import type { Registry } from "./registry.ts";
import { type TurnOutcome, watchTurns } from "./turns.ts";

const TITLE_MAX = 60;
const MESSAGE_MAX = 240;

// Apps currently open and in front of someone. Each holds the events stream
// only while it's visible, so a stream counts as a viewer.
export class Viewers {
	private count = 0;
	private listeners = new Set<(watching: boolean) => void>();
	private bySession = new Map<string, number>(); // viewers per session they're showing
	private viewingFns = new Set<(sessionId: string, viewing: boolean) => void>();

	// sessionId: the session this viewer is looking at, if any.
	add(sessionId?: string | null): () => void {
		if (++this.count === 1) this.emit(true);
		if (sessionId) {
			const n = (this.bySession.get(sessionId) ?? 0) + 1;
			this.bySession.set(sessionId, n);
			if (n === 1) this.emitViewing(sessionId, true);
		}
		let left = false;
		return () => {
			if (left) return;
			left = true;
			if (sessionId) {
				const n = (this.bySession.get(sessionId) ?? 1) - 1;
				if (n > 0) this.bySession.set(sessionId, n);
				else {
					this.bySession.delete(sessionId);
					this.emitViewing(sessionId, false);
				}
			}
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

	// Fired when one session's viewer count crosses zero either way.
	onViewing(fn: (sessionId: string, viewing: boolean) => void): () => void {
		this.viewingFns.add(fn);
		return () => {
			this.viewingFns.delete(fn);
		};
	}

	private emitViewing(sessionId: string, viewing: boolean): void {
		for (const fn of [...this.viewingFns]) fn(sessionId, viewing);
	}

	watching(): boolean {
		return this.count > 0;
	}

	viewing(sessionId: string): boolean {
		return this.bySession.has(sessionId);
	}
}

// Forwards each turn outcome with its snapshot; who gets told, and what, is the Notifier's call.
export function watchPush(registry: Pick<Registry, "onChange" | "get">, onOutcome: (o: TurnOutcome, snap: Snapshot) => void): () => void {
	return watchTurns(registry, onOutcome);
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
