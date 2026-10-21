import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MAX_IMAGE_FILE_BYTES, showImage } from "../show-image.ts";

const dir = mkdtempSync(join(tmpdir(), "show-image-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
writeFileSync(join(dir, "shot.png"), PNG);
mkdirSync(join(dir, "sub"));
writeFileSync(join(dir, "sub", "rel.png"), PNG);

test("a png is returned as an image block the model sees", async () => {
	const path = join(dir, "shot.png");
	const r = await showImage({ path }, dir);
	assert.deepEqual(r.content, [
		{ type: "text", text: "Displayed in the conversation: shot.png" },
		{ type: "image", mimeType: "image/png", data: PNG.toString("base64") },
	]);
	assert.deepEqual(r.details, { path, mimeType: "image/png", bytes: PNG.length });
});

test("see: false keeps the image out of content", async () => {
	const r = await showImage({ path: "shot.png", see: false }, dir);
	assert.deepEqual(r.content, [{ type: "text", text: "Displayed in the conversation: shot.png" }]);
	assert.deepEqual(r.details.image, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
});

test("a relative path resolves against cwd", async () => {
	const r = await showImage({ path: "rel.png" }, join(dir, "sub"));
	assert.equal(r.details.path, join(dir, "sub", "rel.png"));
});

test("the caption is kept in details", async () => {
	const r = await showImage({ path: "shot.png", caption: "a pixel" }, dir);
	assert.equal(r.details.caption, "a pixel");
});

test("a file over 2 MB is refused with a downscale hint", async () => {
	writeFileSync(join(dir, "big.png"), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_FILE_BYTES)]));
	await assert.rejects(showImage({ path: "big.png" }, dir), (e: Error) => /2 MB/.test(e.message) && /downscale/i.test(e.message));
});

test("a non-image is refused", async () => {
	writeFileSync(join(dir, "fake.png"), "just text");
	await assert.rejects(showImage({ path: "fake.png" }, dir), /not a PNG, JPEG, GIF or WebP/);
});

test("a missing file is refused", async () => {
	await assert.rejects(showImage({ path: "nope.png" }, dir), (e: Error) => e.message.includes(join(dir, "nope.png")));
});
