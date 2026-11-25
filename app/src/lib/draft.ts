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
	superpowers: boolean; // what the draft's switch said; applied once pi is up
	type: SessionType; // the draft's type: the superpowers default to compare against, known before the list has the session
}

// The superpowers switch to send after the hand-off, or null when pi already
// matches. `status` is what the session reports (undefined until the extension
// has said); without it pi runs with the switch off, whatever the type.
export function superpowersCommand(want: boolean, status: boolean | undefined, _type: SessionType): boolean | null {
	const current = status ?? false;
	return want === current ? null : want;
}

// A new chat starts in the home folder with superpowers off (2026-11-25: the skills are manual until the switch is on).
export function freshDraft(_type: SessionType): Draft {
	return { text: "", images: [], files: [], cwd: "~", model: null, thinking: null, approval: null, superpowers: false };
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
