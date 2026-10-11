import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, checkImageFile } from "./images.ts";

describe("checkImageFile", () => {
	it("accepts allowed types up to 5 MB", () => {
		for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) expect(checkImageFile({ type, size: 1000 })).toBe(true);
		expect(checkImageFile({ type: "image/png", size: MAX_IMAGE_BYTES })).toBe(true);
	});
	it("rejects other types, empty type and oversize", () => {
		expect(checkImageFile({ type: "image/svg+xml", size: 10 })).toBe(false);
		expect(checkImageFile({ type: "", size: 10 })).toBe(false);
		expect(checkImageFile({ type: "image/png", size: MAX_IMAGE_BYTES + 1 })).toBe(false);
	});
});
