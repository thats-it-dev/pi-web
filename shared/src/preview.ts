// Derives the Preview tab's state (the running preview's url) from a conversation.
// Pure: the hub and the app both call it on the same Conversation.

import type { Conversation } from "./protocol.ts";

export const PREVIEW_TOOL = "preview";
export type PreviewKind = "dev" | "static" | "pages"; // "pages" is for the UI only
/** id: the preview call's toolCallId, so a restart on the same url is a new state; at: when it landed (0 while live). */
export interface PreviewState { id: string; url: string; label: string; kind: PreviewKind; at: number }

/** The latest successful `preview` result with a url; null after a later `{stopped:true}` or when there is none. */
export function derivePreview(conv: Conversation): PreviewState | null {
	let state: PreviewState | null = null;
	const apply = (id: string, details: unknown, at: number) => {
		if (!details || typeof details !== "object") return;
		const d = details as Record<string, unknown>;
		if (d.stopped === true) state = null;
		else if (typeof d.url === "string") {
			state = {
				id,
				url: d.url,
				label: typeof d.label === "string" ? d.label : "",
				kind: d.kind === "static" ? "static" : "dev",
				at,
			};
		}
	};
	const seen = new Set<string>();
	for (const m of conv.messages) {
		if (m.role !== "toolResult" || m.toolName !== PREVIEW_TOOL) continue;
		const id = String(m.toolCallId);
		seen.add(id);
		if (m.isError === true) continue;
		apply(id, m.details, typeof m.timestamp === "number" ? m.timestamp : 0);
	}
	for (const [id, t] of Object.entries(conv.tools)) {
		if (t.name !== PREVIEW_TOOL || t.running || !t.result || t.isError || seen.has(id)) continue;
		apply(id, (t.result as { details?: unknown }).details, 0);
	}
	return state;
}
