import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.ts";

describe("renderMarkdown", () => {
	it("renders ordinary markdown", () => {
		expect(renderMarkdown("**bold** and `code`")).toContain("<strong>bold</strong>");
		expect(renderMarkdown("```\n<b>x</b>\n```")).toContain("&lt;b&gt;x&lt;/b&gt;");
	});
	it("escapes raw HTML from the model", () => {
		const out = renderMarkdown('<script>alert(1)</script>\n\nhi <img src=x onerror="alert(1)">');
		expect(out).not.toMatch(/<script|<img/i);
		expect(out).toContain("&lt;script&gt;");
	});
	it("only links http(s) and mailto", () => {
		expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a");
		const ok = renderMarkdown("[site](https://thatsit.dev/?a=1&b=2)");
		expect(ok).toContain('href="https://thatsit.dev/?a=1&amp;b=2"');
		expect(ok).toContain('rel="noopener noreferrer"');
	});
	it("turns images into links instead of loading them", () => {
		const out = renderMarkdown("![diagram](https://example.com/a.png)");
		expect(out).not.toContain("<img");
		expect(out).toContain('href="https://example.com/a.png"');
	});
});
