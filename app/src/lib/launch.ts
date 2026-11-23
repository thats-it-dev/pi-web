import type { SessionSummary, SessionType } from "../../../shared/src/protocol.ts";
import { filterByType } from "./format.ts";
import type { Route } from "./route.ts";

export const RECENT_MS = 2 * 60 * 60 * 1000;

/** Where the app opens: a running chat, else a recent one, else a new chat. */
export function launchRoute(sessions: SessionSummary[], now: number, type: SessionType): Route {
	sessions = filterByType(sessions, type);
	const latest = (list: SessionSummary[]) => list.reduce<SessionSummary | null>((a, s) => (!a || s.updatedAt > a.updatedAt ? s : a), null);
	const pick = latest(sessions.filter((s) => s.live)) ?? latest(sessions);
	if (pick && (pick.live || now - pick.updatedAt <= RECENT_MS)) return { name: "session", id: pick.id };
	return { name: "new" };
}
