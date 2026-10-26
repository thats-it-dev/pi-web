import { beforeEach, describe, expect, it } from "vitest";
import { getDraft, handOff, resetDraft, takeHandoff, updateDraft } from "./draft.ts";

beforeEach(() => {
	resetDraft();
	takeHandoff("s1");
});

describe("draft chat", () => {
	it("a fresh draft is ~ with no model", () => {
		expect(getDraft()).toEqual({ text: "", images: [], cwd: "~", model: null, thinking: null, approval: null });
	});
	it("takeHandoff returns the message once", () => {
		const msg = { text: "hi", images: [], approval: null };
		handOff("s1", msg);
		expect(takeHandoff("s2")).toBeNull();
		expect(takeHandoff("s1")).toEqual(msg);
		expect(takeHandoff("s1")).toBeNull();
	});
	it("resetDraft clears text, images, folder and model", () => {
		updateDraft({ text: "x", images: [{ mimeType: "image/png", data: "a" }], cwd: "/a", model: { provider: "p", modelId: "m" } });
		resetDraft();
		expect(getDraft()).toEqual({ text: "", images: [], cwd: "~", model: null, thinking: null, approval: null });
	});
});
