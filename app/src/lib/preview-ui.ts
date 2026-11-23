// Pure UI logic for the Preview tab: layout mode, viewport stage scaling,
// aside size cycle and tab persistence parsing.
export type PreviewMode = "card" | "fullscreen" | "panel";
export const PHONE_MAX_W = 599; // < 600 is a phone
export const TABLET_MAX_W = 899; // 600-899 is a tablet

export function previewMode(width: number): PreviewMode {
	if (width <= PHONE_MAX_W) return "card";
	if (width <= TABLET_MAX_W) return "fullscreen";
	return "panel";
}

export type Viewport = "fit" | "390" | "768";
export const VIEWPORTS: Viewport[] = ["fit", "390", "768"];

/** iframe css width/height and the scale that fits `preset` into a stage of stageW x stageH. fit -> stage size, scale 1. */
export function stageFor(preset: Viewport, stageW: number, stageH: number): { width: number; height: number; scale: number } {
	if (preset === "fit") return { width: stageW, height: stageH, scale: 1 };
	const width = Number(preset);
	if (width <= stageW) return { width, height: stageH, scale: 1 };
	const scale = stageW / width;
	return { width, height: Math.round(stageH / scale), scale };
}

export type AsideSize = "default" | "half" | "full"; // mirrors the kit's
const SIZES: AsideSize[] = ["default", "half", "full"];
export function nextSize(size: AsideSize): AsideSize {
	return SIZES[(SIZES.indexOf(size) + 1) % SIZES.length];
}

export function readTab(raw: string | null): "progress" | "preview" {
	return raw === "preview" ? "preview" : "progress";
}

/** Reload the iframe in place: the same url announced by a new preview call (pi restarted it). A new url changes src anyway. */
export function shouldReload(prev: { url: string; id: string } | null | undefined, next: { url: string; id: string } | null): boolean {
	return !!prev && !!next && prev.url === next.url && prev.id !== next.id;
}

export const POLL_MS = 15_000;
export const POLL_MAX_MS = 60_000;
/** The wait before the next health poll: back to 15 s on an answer, doubling (to 60 s) while the server is down. */
export function nextPollDelay(prev: number, alive: boolean): number {
	return alive ? POLL_MS : Math.min(Math.max(prev, POLL_MS) * 2, POLL_MAX_MS);
}
