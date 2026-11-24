export interface JumpState {
	at: number | null;
	jumped: number | null;
	sessionId: string;
	jumpedSession: string | null;
	messages: number;
}

// The ordinal to scroll to now, or null: nothing asked, messages not loaded yet, or already jumped there.
export function nextJump(s: JumpState): number | null {
	if (s.at === null || s.messages === 0) return null;
	if (s.at === s.jumped && s.sessionId === s.jumpedSession) return null;
	return s.at;
}
