import { expect, test } from "vitest";
import { optionalNumber } from "./optional-number.ts";

test("optionalNumber maps empty, null and non-finite to undefined", () => {
	expect(optionalNumber.fromAttribute("")).toBeUndefined();
	expect(optionalNumber.fromAttribute("  ")).toBeUndefined();
	expect(optionalNumber.fromAttribute(null)).toBeUndefined();
	expect(optionalNumber.fromAttribute("abc")).toBeUndefined();
	expect(optionalNumber.fromAttribute("40")).toBe(40);
	expect(optionalNumber.fromAttribute("0")).toBe(0);
});
