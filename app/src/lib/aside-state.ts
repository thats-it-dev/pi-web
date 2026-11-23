// Pure state for the aside's two tabs (Progress, Preview): which preview shows, which tab is active,
// and the tk-shell attributes that follow from them.
import type { PreviewState } from "../../../shared/src/preview.ts";
import { type AsideSize, type PreviewMode, nextSize } from "./preview-ui.ts";

export type AsideTab = "progress" | "preview";

export interface AsideInput {
	derived: PreviewState | null; // from the conversation (pi's preview tool)
	pages: PreviewState | null; // a Pages link opened from the Progress tab
	tab: AsideTab; // the tab last picked
	hasProgress: boolean;
	width: number;
	arrived: boolean; // the derived preview just arrived fresh (isFreshArrival): it takes the tab
}

export const FRESH_MS = 60_000; // a preview this new was just opened by pi, not restored from history

/** A derived preview pi just opened: not seen yet, and live (at 0: its message has not landed) or under a minute old.
 * One restored from history (reopening a chat) is not: the app records it as seen and leaves the tab alone. */
export function isFreshArrival(p: PreviewState | null, seen: ReadonlySet<string>, now: number): boolean {
	return !!p && !seen.has(p.id) && (p.at === 0 || now - p.at < FRESH_MS);
}

/** The preview to show: a Pages link opened after the latest derived preview wins; otherwise the derived one. */
export function shownPreview(i: Pick<AsideInput, "derived" | "pages">): PreviewState | null {
	if (i.pages && (!i.derived || i.pages.at > i.derived.at)) return i.pages;
	return i.derived;
}

/** The tab to show: "preview" when a fresh derived preview arrives; "progress" when there is no preview. */
export function nextTab(i: AsideInput): AsideTab {
	if (!shownPreview(i)) return "progress";
	if (i.arrived && i.derived) return "preview";
	if (!i.hasProgress) return "preview"; // an empty Progress tab shows nothing: the preview is what there is
	return i.tab;
}

/** The shell attributes for this state. */
export function shellAttrs(i: { tab: AsideTab; preview: PreviewState | null; mode: PreviewMode; finePointer: boolean; size: AsideSize }): {
	resizable: boolean;
	dockAside: boolean;
	asideFullscreen: boolean;
	asideSize: AsideSize;
} {
	const previewing = i.tab === "preview" && i.preview !== null;
	return {
		resizable: i.finePointer && i.mode === "panel",
		dockAside: previewing && i.mode === "panel",
		asideFullscreen: previewing && i.mode === "fullscreen",
		asideSize: i.tab === "preview" ? i.size : "default",
	};
}

const WIDE_MIN_W = 1200; // the kit's wide mode; below it (iPad landscape) snap skips the narrow size

/** The size after a snap: narrow, half, full on a wide screen; half and full below 1200px, where narrow is cramped. */
export function snapSize(size: AsideSize, width: number): AsideSize {
	const next = nextSize(size);
	return next === "default" && width < WIDE_MIN_W ? "half" : next;
}
