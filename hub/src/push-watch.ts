// Decides when a session deserves a push (spec §5.5): a run finished, a dialog
// is waiting, or a run ended in an error, and no app is open anywhere to see
// it. Headless sessions only: someone running a terminal session is at the terminal.

import { basename } from "node:path";
import type { AgentMessage, LiveState, PushKind, PushPayload, Snapshot } from "../../shared/src/protocol.ts";
import { contentText } from "../../shared/src/reducer.ts";
import type { Registry } from "./registry.ts";

const TITLE_MAX = 60;

interface Track {
	state: LiveState;
	running: boolean;
	lastBefore: AgentMessage | undefined; // the conversation's last message when the run started
}

// Apps currently open and in front of someone. Each holds the events stream
// only while it's visible, so a stream counts as a viewer.
export class Viewers {
	private count = 0;

	add(): () => void {
		this.count++;
		let left = false;
		return () => {
			if (left) return;
			left = true;
			this.count--;
		};
	}

	watching(): boolean {
		return this.count > 0;
	}
}

export function watchPush(registry: Pick<Registry, "onChange" | "get">, send: (p: PushPayload) => void, viewers?: Pick<Viewers, "watching">): () => void {
	const tracks = new Map<string, Track>();
	return registry.onChange((m) => {
		if (m.type !== "session_state") return;
		const h = registry.get(m.sessionId);
		if (!m.live || !h || h.kind !== "rpc") {
			tracks.delete(m.sessionId);
			return;
		}
		let t = tracks.get(m.sessionId);
		if (!t) {
			t = { state: "idle", running: false, lastBefore: undefined };
			tracks.set(m.sessionId, t);
		}
		if (m.state === t.state) return;
		t.state = m.state;
		const snap = h.snapshot();
		const push = (kind: PushKind) => {
			if (!viewers?.watching()) send({ sessionId: m.sessionId, title: sessionTitle(snap), kind });
		};

		if (m.state === "running" && !t.running) {
			t.running = true;
			t.lastBefore = snap.conv.messages.at(-1);
		}
		if (m.state === "needs_you") push("needs_you");
		if (m.state === "idle" && t.running) {
			t.running = false;
			const last = snap.conv.messages.at(-1);
			if (!last || last === t.lastBefore || last.role !== "assistant") return;
			if (last.stopReason === "error") push("error");
			else if (last.stopReason !== "aborted") push("finished");
		}
	});
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
