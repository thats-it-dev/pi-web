import { beforeEach, describe, expect, it } from "vitest";
import { type Handoff, freshDraft, getDraft, handOff, resetDraft, retypeDraft, superpowersCommand, takeHandoff, updateDraft } from "./draft.ts";

beforeEach(() => {
	resetDraft("code");
	takeHandoff("s1");
});

describe("draft chat", () => {
	it("a fresh code draft is ~ with no model and superpowers on", () => {
		expect(getDraft()).toEqual({ text: "", images: [], files: [], cwd: "~", model: null, thinking: null, approval: null, superpowers: true });
	});
	it("freshDraft: code has superpowers on, chat off, both in ~", () => {
		expect(freshDraft("code")).toMatchObject({ cwd: "~", superpowers: true });
		expect(freshDraft("chat")).toMatchObject({ cwd: "~", superpowers: false });
	});
	it("retypeDraft keeps the text and attachments, resets cwd and superpowers", () => {
		const images = [{ mimeType: "image/png", data: "a" }];
		const files = [{ name: "a.txt", mimeType: "", size: 1, data: "YQ==" }];
		updateDraft({ text: "x", images, files, cwd: "/a", model: { provider: "p", modelId: "m" }, thinking: "high", approval: "auto" });
		retypeDraft("chat");
		expect(getDraft()).toEqual({ text: "x", images, files, cwd: "~", model: { provider: "p", modelId: "m" }, thinking: "high", approval: "auto", superpowers: false });
		updateDraft({ cwd: "/b" });
		retypeDraft("code");
		expect(getDraft()).toMatchObject({ text: "x", cwd: "~", superpowers: true });
	});
	it("takeHandoff returns the message once, superpowers included", () => {
		const msg: Handoff = { text: "hi", images: [], files: [], approval: null, superpowers: false };
		handOff("s1", msg);
		expect(takeHandoff("s2")).toBeNull();
		expect(takeHandoff("s1")).toEqual(msg);
		expect(takeHandoff("s1")).toBeNull();
	});
	it("resetDraft clears text, images, files, folder and model", () => {
		updateDraft({ text: "x", images: [{ mimeType: "image/png", data: "a" }], files: [{ name: "a.txt", mimeType: "", size: 1, data: "YQ==" }], cwd: "/a", model: { provider: "p", modelId: "m" } });
		resetDraft("chat");
		expect(getDraft()).toEqual({ text: "", images: [], files: [], cwd: "~", model: null, thinking: null, approval: null, superpowers: false });
	});
});

describe("superpowersCommand", () => {
	it("code draft off, status on: send off", () => expect(superpowersCommand(false, true, "code")).toBe(false));
	it("chat draft on, status absent (chat default off): send on", () => expect(superpowersCommand(true, undefined, "chat")).toBe(true));
	it("code draft on, status on: nothing", () => expect(superpowersCommand(true, true, "code")).toBeNull());
	it("chat draft off, status absent: nothing", () => expect(superpowersCommand(false, undefined, "chat")).toBeNull());
	it("code draft off, status absent (code default on): send off", () => expect(superpowersCommand(false, undefined, "code")).toBe(false));
	it("a reported status wins over the type default", () => expect(superpowersCommand(true, false, "code")).toBe(true));
});
