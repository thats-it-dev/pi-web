import assert from "node:assert/strict";
import { test } from "node:test";
import { type SavedAttachment, formatAttachments, formatBytes, parseAttachments, summarizeAttachments } from "../src/attachments.ts";

const pdf: SavedAttachment = { name: "report.pdf", size: 1258291, path: "/data/uploads/s1/report.pdf", inline: null };
const notes: SavedAttachment = { name: "notes.md", size: 3174, path: "/data/uploads/s1/notes.md", inline: "hello\n" };

test("formatBytes: B, KB, MB with one decimal", () => {
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(3174), "3.1 KB");
	assert.equal(formatBytes(1258291), "1.2 MB");
});

test("format then parse round-trips names, sizes, paths and the inlined flag; inlined contents are not in the parse", () => {
	const text = formatAttachments("look at these", [pdf, notes]);
	assert.equal(
		text,
		[
			"look at these",
			"",
			"<pi-web-attachments>",
			"- report.pdf (1.2 MB) → /data/uploads/s1/report.pdf",
			"- notes.md (3.1 KB) → /data/uploads/s1/notes.md, contents inlined below",
			"</pi-web-attachments>",
			"",
			'<pi-web-file path="/data/uploads/s1/notes.md">',
			"hello",
			"</pi-web-file>",
		].join("\n"),
	);
	const parsed = parseAttachments(text);
	assert.deepEqual(parsed, {
		text: "look at these",
		files: [
			{ name: "report.pdf", sizeLabel: "1.2 MB", path: "/data/uploads/s1/report.pdf", inlined: false },
			{ name: "notes.md", sizeLabel: "3.1 KB", path: "/data/uploads/s1/notes.md", inlined: true },
		],
	});
	assert.ok(!JSON.stringify(parsed).includes("hello"));
});

test("a files-only message gets the text 'Attached:'", () => {
	assert.ok(formatAttachments("  ", [pdf]).startsWith("Attached:\n\n<pi-web-attachments>\n"));
});

test("parse: no block → null; opening tag without closing → null; a block with no inlined files → inlined false", () => {
	assert.equal(parseAttachments("just text"), null);
	assert.equal(parseAttachments("typed by hand\n\n<pi-web-attachments>\n- x (1 B) → /x"), null);
	const parsed = parseAttachments(formatAttachments("see", [pdf]));
	assert.deepEqual(parsed?.files, [{ name: "report.pdf", sizeLabel: "1.2 MB", path: "/data/uploads/s1/report.pdf", inlined: false }]);
});

test("summarize: text · N files, files-only names the first file, no block → unchanged", () => {
	assert.equal(summarizeAttachments(formatAttachments("fix this", [pdf, notes])), "fix this · 2 files");
	assert.equal(summarizeAttachments(formatAttachments("fix this", [pdf])), "fix this · 1 file");
	assert.equal(summarizeAttachments(formatAttachments("", [pdf])), "report.pdf");
	assert.equal(summarizeAttachments(formatAttachments("", [pdf, notes, pdf])), "report.pdf · 3 files");
	assert.equal(summarizeAttachments("plain\ntext"), "plain\ntext");
});
