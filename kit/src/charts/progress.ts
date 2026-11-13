/** Fraction of `value` against `max`, clamped to 0..1.
 * Returns 0 when max is not a positive finite number. */
export function progressFraction(value: number, max: number): number {
	if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
	return Math.min(1, Math.max(0, value / max));
}
