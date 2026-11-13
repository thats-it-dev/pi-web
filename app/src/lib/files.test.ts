import { describe, expect, it } from "vitest";
import { type Attachment, MAX_FILE_BYTES, MAX_MESSAGE_BYTES, acceptFiles, routeAttachments } from "./files.ts";

const f = (name: string, size: number, type = "") => ({ name, type, size });

describe("acceptFiles", () => {
	it("keeps files within the caps with no error", () => {
		expect(acceptFiles([f("a.txt", 10), f("b.pdf", 1024)], 0)).toEqual({ ok: [f("a.txt", 10), f("b.pdf", 1024)], error: null });
	});
	it("drops a file over 20 MB with the per-file toast", () => {
		const r = acceptFiles([f("big.zip", MAX_FILE_BYTES + 1), f("a.txt", 10)], 0);
		expect(r).toEqual({ ok: [f("a.txt", 10)], error: "Files up to 20 MB can be attached." });
	});
	it("drops files that would push the message over 40 MB with the per-message toast", () => {
		const r = acceptFiles([f("a.bin", 15 * 1024 * 1024)], MAX_MESSAGE_BYTES - 1024);
		expect(r).toEqual({ ok: [], error: "Up to 40 MB of files per message." });
	});
});

describe("routeAttachments", () => {
	const png: Attachment = { kind: "image", name: "shot.png", size: 3, image: { mimeType: "image/png", data: "YWJj" } };
	const txt: Attachment = { kind: "file", file: { name: "a.txt", mimeType: "text/plain", size: 2, data: "aGk=" } };
	it("sends images to images when the model has vision", () => {
		expect(routeAttachments([png, txt], true)).toEqual({ images: [png.image], files: [txt.file] });
	});
	it("sends images as files when the model has no vision", () => {
		expect(routeAttachments([png, txt], false)).toEqual({ images: [], files: [{ name: "shot.png", mimeType: "image/png", size: 3, data: "YWJj" }, txt.file] });
	});
});
