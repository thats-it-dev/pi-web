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

/** Navigation docks from mid up; details docks only in wide, or from mid when there is no navigation. */
export function isDocked(panel: Panel, mode: Mode, present: Record<Panel, boolean>): boolean {
	if (!present[panel] || mode === "phone") return false;
	if (panel === "nav") return true;
	return mode === "wide" || !present.nav;
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
export function panelsState(o: { mode: Mode; present: Record<Panel, boolean>; hidden: Hidden; drawer: Panel | null }): PanelsState {
	const one = (p: Panel): PanelState => {
		const present = o.present[p];
		const docked = isDocked(p, o.mode, o.present);
		const open = present && (docked ? !o.hidden[p] : o.drawer === p);
		return { present, docked, open };
	};
	return { nav: one("nav"), aside: one("aside") };
}
