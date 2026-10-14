// Auto mode: answer a permission extension's dialog on the person's behalf.
// pi itself never asks before a tool call; a permission extension does, with
// a select (Allow / Deny / ...) or a confirm, while a turn is running. With
// autoApprove on, the hub answers those itself so the agent keeps going. A
// dialog outside a running turn (a slash command asking something) still
// reaches the app, as does any select with no recognisable allow option.

import type { Dialog } from "../../shared/src/protocol.ts";

const ALLOW_EXACT = /^(allow|yes|approve|ok|accept)$/i;
const ALLOW_PREFIX = /^(allow|yes|approve|accept)\b/i;

export type AutoAnswer = { value: string } | { confirmed: true };

export function autoAnswer(d: Pick<Dialog, "method" | "options">, running: boolean): AutoAnswer | null {
	if (!running) return null;
	if (d.method === "confirm") return { confirmed: true };
	if (d.method !== "select") return null;
	const options = (d.options ?? []).map((o) => String(o).trim());
	const allow = options.find((o) => ALLOW_EXACT.test(o)) ?? options.find((o) => ALLOW_PREFIX.test(o));
	return allow === undefined ? null : { value: allow };
}
