// The one-line status under the session title. Kept out of the component so
// it can be tested without a DOM.

import type { SessionStore } from "./session-store.ts";

export function headerStatus(s: SessionStore): string | null {
	switch (s.status) {
		case "loading":
			return "loading…";
		case "starting":
			return "starting pi…";
		case "reconnecting":
			return "reconnecting…";
		case "history":
			return s.lastExit ? `pi stopped: ${s.lastExit.split("\n").at(-1)}. Send a message to restart it.` : "pi isn't running for this session. Sending a message starts it.";
	}
	const prompt = s.snapshot?.terminalPrompt;
	if (prompt) return prompt.title ? `waiting for you in the terminal: ${prompt.title}` : "waiting for you in the terminal";
	if (s.conv.retry) return `retrying (${s.conv.retry.attempt}/${s.conv.retry.max})…`;
	if (s.conv.compacting) return "compacting…";
	if (s.snapshot?.handleKind === "bridge") return "open in terminal";
	return null;
}
