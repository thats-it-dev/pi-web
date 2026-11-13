import { beforeEach, describe, expect, it } from "vitest";
import { getDraft, handOff, resetDraft, takeHandoff, updateDraft } from "./draft.ts";

beforeEach(() => {
	resetDraft();
	takeHandoff("s1");
});

describe("draft chat", () => {
	it("a fresh draft is ~ with no model", () => {
		expect(getDraft()).toEqual({ text: "", images: [], files: [], cwd: "~", model: null, thinking: null, approval: null, superpowers: false });
	});
	it("takeHandoff returns the message once", () => {
		const msg = { text: "hi", images: [], files: [], approval: null, superpowers: false };
		handOff("s1", msg);
		expect(takeHandoff("s2")).toBeNull();
		expect(takeHandoff("s1")).toEqual(msg);
		expect(takeHandoff("s1")).toBeNull();
	});
	it("resetDraft clears text, images, files, folder and model", () => {
		updateDraft({ text: "x", images: [{ mimeType: "image/png", data: "a" }], files: [{ name: "a.txt", mimeType: "", size: 1, data: "YQ==" }], cwd: "/a", model: { provider: "p", modelId: "m" } });
		resetDraft();
		expect(getDraft()).toEqual({ text: "", images: [], files: [], cwd: "~", model: null, thinking: null, approval: null, superpowers: false });
	});
});
