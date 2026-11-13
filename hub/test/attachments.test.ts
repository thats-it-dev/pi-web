import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FileInput } from "../../shared/src/protocol.ts";
import { isInlineText, safeName, saveAttachments, withAttachments } from "../src/attachments.ts";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const file = (name: string, body: string | Buffer, mimeType = ""): FileInput => ({ name, mimeType, size: Buffer.byteLength(body), data: b64(body) });
const dir = () => join(mkdtempSync(join(tmpdir(), "pi-web-uploads-")), "s1");

test("safeName drops directories and control characters, and never returns empty", () => {
	assert.equal(safeName("../../x"), "x");
	assert.equal(safeName("a/b\\c.txt"), "c.txt");
	assert.equal(safeName("con\u0000.txt"), "con.txt");
	assert.equal(safeName("  "), "file");
});

test("isInlineText: small UTF-8 yes; a NUL byte no; over 32 KB no; invalid UTF-8 no; containing the closing tag no", () => {
	assert.equal(isInlineText(Buffer.from("héllo\n")), true);
	assert.equal(isInlineText(Buffer.from("a\u0000b")), false);
	assert.equal(isInlineText(Buffer.alloc(32 * 1024 + 1, 0x61)), false);
	assert.equal(isInlineText(Buffer.alloc(32 * 1024, 0x61)), true);
	assert.equal(isInlineText(Buffer.from([0xc3, 0x28])), false);
	assert.equal(isInlineText(Buffer.from("x </pi-web-file> y")), false);
});

test("saveAttachments writes files 0o600 under dir, keeps both on a name collision, and returns inline text only for text files", async () => {
	const d = dir();
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), Buffer.alloc(10, 7)]);
	const saved = await saveAttachments(d, [file("notes.md", "hello\n", "text/markdown"), file("report.pdf", png), file("report.pdf", png)]);
	assert.deepEqual(
		saved.map((s) => ({ ...s, path: s.path.replace(d, "<d>") })),
		[
			{ name: "notes.md", size: 6, path: "<d>/notes.md", inline: "hello\n" },
			{ name: "report.pdf", size: 16, path: "<d>/report.pdf", inline: null },
			{ name: "report (2).pdf", size: 16, path: "<d>/report (2).pdf", inline: null },
		],
	);
	assert.deepEqual(readdirSync(d).sort(), ["notes.md", "report (2).pdf", "report.pdf"]);
	assert.equal(readFileSync(join(d, "notes.md"), "utf8"), "hello\n");
	assert.equal(statSync(join(d, "notes.md")).mode & 0o777, 0o600);
	assert.equal(statSync(d).mode & 0o777, 0o700);
});

test("saveAttachments refuses a file over 20 MB with 413 and writes nothing", async () => {
	const d = dir();
	const big: FileInput = { name: "big.bin", mimeType: "", size: 20 * 1024 * 1024 + 1, data: b64(Buffer.alloc(20 * 1024 * 1024 + 1)) };
	await assert.rejects(saveAttachments(d, [file("small.txt", "x"), big]), (e: Error & { status?: number }) => e.status === 413 && e.message === "big.bin is over 20 MB");
	assert.throws(() => readdirSync(d), /ENOENT/);
});

test("withAttachments rewrites the text, strips files, and leaves a prompt without files untouched", async () => {
	const d = dir();
	const plain = { type: "prompt" as const, text: "hi", mode: "send" as const };
	assert.equal(await withAttachments(plain, d), plain);
	const out = await withAttachments({ ...plain, text: "read it", files: [file("notes.md", "hello\n")] }, d);
	assert.equal(out.files, undefined);
	assert.ok(out.text.startsWith("read it\n\n<pi-web-attachments>\n"));
	assert.ok(out.text.includes(`→ ${join(d, "notes.md")}, contents inlined below`));
	assert.ok(out.text.includes(`<pi-web-file path="${join(d, "notes.md")}">\nhello\n</pi-web-file>`));
});
