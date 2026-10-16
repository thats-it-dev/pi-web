import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../src/errors.ts";
import { parseMultipart } from "../src/multipart.ts";

const CT = "multipart/form-data; boundary=----b";
const audio = Buffer.concat([
	Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
	Buffer.from("\r\n"),
	Buffer.from("--not-a-boundary\r\n"),
	Buffer.from([0, 255, 13, 10]),
]);

function field(name: string, value: string): Buffer {
	return Buffer.from(`------b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
}

function fixture(closing = true): Buffer {
	return Buffer.concat([
		field("transcription", "hello world"),
		field("recordedAt", "1700000000000"),
		Buffer.from('------b\r\nContent-Disposition: form-data; name="audio"; filename="abc.m4a"\r\nContent-Type: audio/mp4\r\n\r\n'),
		audio,
		Buffer.from("\r\n"),
		Buffer.from(closing ? "------b--\r\n" : ""),
	]);
}

function status(fn: () => unknown): number | undefined {
	try {
		fn();
	} catch (e) {
		return e instanceof HttpError ? e.status : undefined;
	}
	return undefined;
}

test("parses text and binary parts exactly", () => {
	const parts = parseMultipart(fixture(), CT);
	assert.deepEqual(parts.map((p) => p.name), ["transcription", "recordedAt", "audio"]);
	assert.equal(parts[0].data.toString(), "hello world");
	assert.equal(parts[0].filename, undefined);
	assert.equal(parts[1].data.toString(), "1700000000000");
	assert.equal(parts[2].filename, "abc.m4a");
	assert.equal(parts[2].contentType, "audio/mp4");
	assert.ok(parts[2].data.equals(audio));
});

test("quoted boundary and case-insensitive part headers", () => {
	const body = Buffer.from('--q\r\ncontent-disposition: form-data; name="a"\r\n\r\nv\r\n--q--\r\n');
	const parts = parseMultipart(body, 'multipart/form-data; boundary="q"');
	assert.equal(parts[0].name, "a");
	assert.equal(parts[0].data.toString(), "v");
});

test("missing closing delimiter, missing boundary and headerless part are 400", () => {
	assert.equal(status(() => parseMultipart(fixture(false), CT)), 400);
	assert.equal(status(() => parseMultipart(fixture(), "multipart/form-data")), 400);
	assert.equal(status(() => parseMultipart(fixture(), undefined)), 400);
	assert.equal(status(() => parseMultipart(Buffer.from("--q\r\nno terminator\r\n--q--\r\n"), "multipart/form-data; boundary=q")), 400);
});

test("an empty part list parses to []", () => {
	assert.deepEqual(parseMultipart(Buffer.from("------b--\r\n"), CT), []);
});
