/** Attribute converter for an optional number: "", null and anything non-finite mean "not set". */
export const optionalNumber = {
	fromAttribute(value: string | null): number | undefined {
		if (value === null || value.trim() === "") return undefined;
		const n = Number(value);
		return Number.isFinite(n) ? n : undefined;
	},
};
