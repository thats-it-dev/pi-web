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
	it("never produces an executable link or image from hostile input", () => {
		const hostile = [
			"[x](&#106;avascript:alert(1))",
			"[x](&#x6A;avascript:alert(1))",
			"[x](JaVaScRiPt:alert(1))",
			"[x]( javascript:alert(1))",
			"[x](<javascript:alert(1)>)",
			"[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
			"[x](vbscript:msgbox(1))",
			"[x](//evil.com/a)",
			"<javascript:alert(1)>",
			"[x][ref]\n\n[ref]: javascript:alert(1)",
			"![x](javascript:alert(1))",
			"![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)",
			"[x](java\tscript:alert(1))",
		];
		for (const src of hostile) {
			const out = renderMarkdown(src);
			expect(out, src).not.toMatch(/<img|<script/i);
			for (const [, href] of out.matchAll(/<a [^>]*href="([^"]*)"/g)) expect(href, src).toMatch(/^(https?:|mailto:)/i);
			expect(out, src).not.toMatch(/href="(?!https?:|mailto:)/i);
		}
	});
	it("cannot break out of the href attribute", () => {
		const out = renderMarkdown('[x](https://ok.dev/"onmouseover="alert(1))');
		const tags = [...out.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
		expect(tags).toHaveLength(1);
		expect(tags[0]).toContain("&quot;onmouseover=&quot;");
		for (const tag of tags) {
			expect(tag).not.toMatch(/\sonmouseover=/i);
			expect(tag).toMatch(/^<a href="[^"]*" target="_blank" rel="noopener noreferrer">$/);
		}
		expect(renderMarkdown('<a href="https://x" onclick="alert(1)">hi</a>')).not.toMatch(/<a\b/);
	});
});

