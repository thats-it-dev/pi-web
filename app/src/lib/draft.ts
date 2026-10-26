import type { ApprovalMode, ImageInput, ThinkingLevel } from "../../../shared/src/protocol.ts";

export interface Draft {
	text: string;
	images: ImageInput[];
	cwd: string;
	model: { provider: string; modelId: string } | null;
	thinking: ThinkingLevel | null;
	approval: ApprovalMode | null;
}

export interface Handoff {
	text: string;
	images: ImageInput[];
	approval: ApprovalMode | null;
}

const fresh = (): Draft => ({ text: "", images: [], cwd: "~", model: null, thinking: null, approval: null });

// The new-chat draft and the first message waiting for its session; one per tab.
let draft = fresh();
let handoff: { sessionId: string; msg: Handoff } | null = null;

export function getDraft(): Draft {
	return draft;
}

export function updateDraft(p: Partial<Draft>): void {
	draft = { ...draft, ...p };
}

export function resetDraft(): void {
	draft = fresh();
}

export function handOff(sessionId: string, msg: Handoff): void {
	handoff = { sessionId, msg };
}

export function takeHandoff(sessionId: string): Handoff | null {
	if (handoff?.sessionId !== sessionId) return null;
	const { msg } = handoff;
	handoff = null;
	return msg;
}
