export { LiveStats, type LiveContext, type Speed } from "../../../shared/src/live-stats.ts";
import type { LiveContext, Speed } from "../../../shared/src/live-stats.ts";
import { formatTokens } from "./format.ts";

export function contextLabel(c: LiveContext): string {
	return `${c.estimated ? "~" : ""}${formatTokens(c.tokens)} / ${formatTokens(c.contextWindow)}`;
}

export function speedLabel(s: Speed): string {
	return `${s.estimated ? "~" : ""}${s.tps < 10 ? s.tps.toFixed(1) : Math.round(s.tps)} tok/s`;
}
