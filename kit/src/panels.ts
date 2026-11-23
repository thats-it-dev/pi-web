// Pure layout state for tk-shell's side panels: which panels dock as columns,
// which are drawers, and which are open. No DOM access, so it is unit-testable.

export type Panel = "nav" | "aside";
export type Mode = "phone" | "mid" | "wide";

/** Widest viewport (px) still treated as a phone. */
export const PHONE_MAX = 899;
/** Narrowest viewport (px) at which details docks next to navigation. */
export const WIDE_MIN = 1200;

/** Per-panel "user hid the docked column" flags. */
export type Hidden = Record<Panel, boolean>;
export type PanelState = { present: boolean; docked: boolean; open: boolean };
export type PanelsState = Record<Panel, PanelState>;

export function modeFor(width: number): Mode {
	if (width <= PHONE_MAX) return "phone";
	return width >= WIDE_MIN ? "wide" : "mid";
}

export type AsideSize = "default" | "half" | "full";

/** Docked navigation column width (px). */
export const SIDEBAR_W = 280;
/** Aside column width (px) when the user has not dragged it. */
export const ASIDE_DEFAULT_W = 300;
/** Narrowest the aside may be dragged (px). */
export const ASIDE_MIN_W = 240;
/** Width (px) the main column always keeps beside a docked aside. */
export const CHAT_FLOOR = 360;
/** Width (px) of the main column strip left in the full aside size. */
export const MAIN_STRIP = 48;

/** Whether a docked nav still leaves the chat its floor beside an aside this wide. */
export function navFits(o: { total: number; asideW: number }): boolean {
	return o.total - o.asideW - CHAT_FLOOR >= SIDEBAR_W;
}

/** Navigation docks from mid up; details docks only in wide, or from mid when there is no navigation or dockAside is set. With total+asideW the nav un-docks when it no longer fits beside the aside. */
export function isDocked(panel: Panel, mode: Mode, present: Record<Panel, boolean>, opts: { dockAside?: boolean; total?: number; asideW?: number } = {}): boolean {
	if (!present[panel] || mode === "phone") return false;
	if (panel === "nav") {
		if (present.aside && opts.total !== undefined && opts.asideW !== undefined && (opts.dockAside || mode === "wide")) {
			return navFits({ total: opts.total, asideW: opts.asideW });
		}
		return true;
	}
	return mode === "wide" || !present.nav || opts.dockAside === true;
}

/** A dragged width clamped to [ASIDE_MIN_W, total - (navDocked ? SIDEBAR_W : 0) - CHAT_FLOOR]. */
export function clampAsideWidth(px: number, o: { total: number; navDocked: boolean }): number {
	const max = o.total - (o.navDocked ? SIDEBAR_W : 0) - CHAT_FLOOR;
	return Math.max(ASIDE_MIN_W, Math.min(px, max));
}

/** The aside column width in px for a size, clamped so the main column keeps CHAT_FLOOR (or MAIN_STRIP in full). */
export function asideWidthFor(size: AsideSize, o: { total: number; navDocked: boolean; stored: number | null }): number {
	const space = o.total - (o.navDocked ? SIDEBAR_W : 0);
	if (size === "full") return Math.max(ASIDE_MIN_W, space - MAIN_STRIP);
	const want = size === "half" ? Math.round(space / 2) : (o.stored ?? ASIDE_DEFAULT_W);
	return clampAsideWidth(want, o);
}

/** Parse a stored aside width: a finite integer in [ASIDE_MIN_W, 10000], else null. */
export function readAsideWidth(raw: string | null): number | null {
	if (raw === null || !/^\d+$/.test(raw)) return null;
	const n = Number(raw);
	return n >= ASIDE_MIN_W && n <= 10000 ? n : null;
}

export function writeAsideWidth(px: number): string {
	return String(Math.round(px));
}

/** Parse stored hidden flags; anything that is not an object of booleans falls back per key. */
export function readHidden(raw: string | null, fallback: Hidden): Hidden {
	const out: Hidden = { ...fallback };
	if (!raw) return out;
	try {
		const v: unknown = JSON.parse(raw);
		if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
		const o = v as Record<string, unknown>;
		for (const k of ["nav", "aside"] as const) if (typeof o[k] === "boolean") out[k] = o[k];
	} catch {
		// unparseable storage: keep the fallback
	}
	return out;
}

export function writeHidden(h: Hidden): string {
	return JSON.stringify({ nav: h.nav, aside: h.aside });
}

/** A docked panel is open unless hidden; an undocked one is open only while it is the drawer. */
export function panelsState(o: { mode: Mode; present: Record<Panel, boolean>; hidden: Hidden; drawer: Panel | null; dockAside?: boolean; total?: number; asideW?: number }): PanelsState {
	const one = (p: Panel): PanelState => {
		const present = o.present[p];
		const docked = isDocked(p, o.mode, o.present, { dockAside: o.dockAside, total: o.total, asideW: o.asideW });
		const open = present && (docked ? !o.hidden[p] : o.drawer === p);
		return { present, docked, open };
	};
	return { nav: one("nav"), aside: one("aside") };
}
