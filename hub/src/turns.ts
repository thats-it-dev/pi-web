// The one tracker of how a headless session's turns end (spec §4): a dialog is
// waiting, or a run finished or errored with a new assistant message. Push and
// the watch both consume it. Terminal sessions are skipped: someone is at the terminal.

import type { AgentMessage, LiveState, Snapshot } from "../../shared/src/protocol.ts";
import { contentText } from "../../shared/src/reducer.ts";
import type { Registry } from "./registry.ts";

export type TurnOutcome = { sessionId: string; kind: "needs_you" } | { sessionId: string; kind: "finished" | "error"; messageIndex: number; text: string };

interface Track {
	state: LiveState;
	running: boolean;
	lastBefore: AgentMessage | undefined; // the conversation's last message when the run started
}

export function watchTurns(registry: Pick<Registry, "onChange" | "get">, onOutcome: (o: TurnOutcome, snap: Snapshot) => void): () => void {
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

		if (m.state === "running" && !t.running) {
			t.running = true;
			t.lastBefore = snap.conv.messages.at(-1);
		}
		if (m.state === "needs_you") onOutcome({ sessionId: m.sessionId, kind: "needs_you" }, snap);
		if (m.state === "idle" && t.running) {
			t.running = false;
			const ended = runEnding(snap.conv.messages, t.lastBefore);
			if (ended) onOutcome({ sessionId: m.sessionId, ...ended }, snap);
		}
	});
}

// How a run ended, judged by the message it left last; null when it added no
// assistant message (a manual compaction) or was aborted.
function runEnding(messages: AgentMessage[], lastBefore: AgentMessage | undefined): { kind: "finished" | "error"; messageIndex: number; text: string } | null {
	const messageIndex = messages.length - 1;
	const last = messages[messageIndex];
	if (!last || last === lastBefore || last.role !== "assistant" || last.stopReason === "aborted") return null;
	if (last.stopReason !== "error") return { kind: "finished", messageIndex, text: contentText(last.content) };
	const text = typeof last.errorMessage === "string" ? last.errorMessage : contentText(last.content);
	return { kind: "error", messageIndex, text };
}
