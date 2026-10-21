import assert from "node:assert/strict";
import { test } from "node:test";
import { imageDimensions, sniffImageType } from "../src/images.ts";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const le32 = (n: number) => [...le16(n & 0xffff), ...le16(n >>> 16)];

const png = (w: number, h: number) =>
	new Uint8Array([0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
const gif = (w: number, h: number) => new Uint8Array([...ascii("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0]);
const webp = (fourcc: string, payload: number[]) =>
	new Uint8Array([...ascii("RIFF"), ...le32(4 + 8 + payload.length), ...ascii("WEBP"), ...ascii(fourcc), ...le32(payload.length), ...payload]);
const jpeg = (w: number, h: number) =>
	new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...be16(16), ...ascii("JFIF"), 0, 1, 1, 0, ...be16(1), ...be16(1), 0, 0, 0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

test("sniffs png, jpeg, gif and webp", () => {
	assert.equal(sniffImageType(png(1, 1)), "image/png");
	assert.equal(sniffImageType(jpeg(1, 1)), "image/jpeg");
	assert.equal(sniffImageType(gif(1, 1)), "image/gif");
	assert.equal(sniffImageType(webp("VP8X", new Array(10).fill(0))), "image/webp");
});

test("rejects other bytes", () => {
	assert.equal(sniffImageType(new Uint8Array(ascii("%PDF-"))), null);
	assert.equal(sniffImageType(new Uint8Array()), null);
});

test("reads png dimensions", () => {
	assert.deepEqual(imageDimensions(png(200, 228), "image/png"), { width: 200, height: 228 });
});

test("reads gif and webp dimensions", () => {
	assert.deepEqual(imageDimensions(gif(320, 240), "image/gif"), { width: 320, height: 240 });
	// VP8X: flags(1) reserved(3) width-1 (24 bit) height-1 (24 bit)
	const vp8x = webp("VP8X", [0, 0, 0, 0, ...le24(639), ...le24(479)]);
	assert.deepEqual(imageDimensions(vp8x, "image/webp"), { width: 640, height: 480 });
	// VP8: frame tag(3) start code 9d 01 2a, then 14-bit width and height
	const vp8 = webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(300), ...le16(150)]);
	assert.deepEqual(imageDimensions(vp8, "image/webp"), { width: 300, height: 150 });
	// VP8L: signature 0x2f, then 14-bit (width-1) and 14-bit (height-1) packed little-endian
	const bits = 99 | (49 << 14);
	const vp8l = webp("VP8L", [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
	assert.deepEqual(imageDimensions(vp8l, "image/webp"), { width: 100, height: 50 });
});

test("reads jpeg dimensions from the first SOF marker", () => {
	assert.deepEqual(imageDimensions(jpeg(1024, 768), "image/jpeg"), { width: 1024, height: 768 });
});

test("returns null for a truncated header", () => {
	assert.equal(imageDimensions(png(5, 5).subarray(0, 20), "image/png"), null);
	assert.equal(imageDimensions(gif(5, 5).subarray(0, 8), "image/gif"), null);
	assert.equal(imageDimensions(webp("VP8X", [0, 0, 0, 0, 1]).subarray(0, 24), "image/webp"), null);
	assert.equal(imageDimensions(jpeg(5, 5).subarray(0, 26), "image/jpeg"), null);
});
