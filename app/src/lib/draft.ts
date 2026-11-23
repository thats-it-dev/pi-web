import type { ApprovalMode, FileInput, ImageInput, SessionType, ThinkingLevel } from "../../../shared/src/protocol.ts";

export interface Draft {
	text: string;
	images: ImageInput[];
	files: FileInput[];
	cwd: string;
	model: { provider: string; modelId: string } | null;
	thinking: ThinkingLevel | null;
	approval: ApprovalMode | null;
	superpowers: boolean;
}

export interface Handoff {
	text: string;
	images: ImageInput[];
	files: FileInput[];
	approval: ApprovalMode | null;
}

// A new chat starts in the home folder; code sessions have superpowers on, chats off.
export function freshDraft(type: SessionType): Draft {
	return { text: "", images: [], files: [], cwd: "~", model: null, thinking: null, approval: null, superpowers: type === "code" };
}

// The new-chat draft and the first message waiting for its session; one per tab.
let draft = freshDraft("code");
let handoff: { sessionId: string; msg: Handoff } | null = null;

export function getDraft(): Draft {
	return draft;
}

export function updateDraft(p: Partial<Draft>): void {
	draft = { ...draft, ...p };
}

export function resetDraft(type: SessionType): void {
	draft = freshDraft(type);
}

// The type changed under an unsent draft: keep what was typed, attached and
// picked; the folder and superpowers go back to the new type's defaults.
export function retypeDraft(type: SessionType): void {
	const { cwd, superpowers } = freshDraft(type);
	draft = { ...draft, cwd, superpowers };
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
