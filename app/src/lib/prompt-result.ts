import type { CommandResult } from "../../../shared/src/protocol.ts";

export const MESSAGE_SWALLOWED = "pi took that as a command and gave no reply. Your message is back in the composer; send it again.";

/** A message (not a slash command) that pi accepted, answered at once with disposition "handled", and never started a
 *  run for: an extension's input handler consumed it, so nobody will read it. The composer gets it back with a warning
 *  instead of letting it vanish (2026-11-19: a message sent as the superpowers switch flipped was never seen again). */
export function swallowed(text: string, r: CommandResult | null): boolean {
	if (!r?.ok || r.pending || text.trimStart().startsWith("/")) return false;
	return (r.data as { disposition?: unknown } | undefined)?.disposition === "handled";
}
