/**
 * Warns when rows exist but none of them has the named field: `x`, `y`, `label` and `value` name
 * fields of the rows, so a typo (or display text) silently draws nothing. The caller invokes this
 * once per data or field change.
 */
export function warnMissingFields(tag: string, rows: readonly unknown[], fields: Record<string, string>): void {
	if (rows.length === 0) return;
	for (const [attr, field] of Object.entries(fields)) {
		const found = rows.some((r) => r !== null && typeof r === "object" && field in (r as object));
		if (!found) console.warn(`${tag}: no row has a "${field}" field (the "${attr}" attribute names a field of your rows, not display text)`);
	}
}
