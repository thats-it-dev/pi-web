// Small decisions behind the composer and the chat on touch screens, kept pure so they can be tested.
// "onScreenKeyboard" is the kit's <html data-keyboard>: the visible area shrank by a keyboard's height.

const JITTER = 2; // px of scroll that don't count as the person moving

/** Enter sends unless the on-screen keyboard is the one typing (its Return makes a new line; Shift+Enter always does). */
export function enterSends(e: { key: string; shiftKey: boolean; isComposing: boolean }, env: { finePointer: boolean; onScreenKeyboard: boolean }): boolean {
	if (e.key !== "Enter" || e.shiftKey || e.isComposing) return false;
	return env.finePointer || !env.onScreenKeyboard;
}

/** Typing on a touch device while no on-screen keyboard is up: a keyboard attached to a phone or iPad. */
export function hardwareKeyboard(env: { coarse: boolean; onScreenKeyboard: boolean }): boolean {
	return env.coarse && !env.onScreenKeyboard;
}

/** Whether the header hides after a scroll the person made: down hides it, any move back up shows it. */
export function nextTucked(prev: boolean, s: { top: number; delta: number }): boolean {
	if (s.top <= 0) return false;
	if (s.delta > JITTER) return true;
	if (s.delta < -JITTER) return false;
	return prev;
}
