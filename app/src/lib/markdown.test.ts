import { afterEach, describe, expect, it } from "vitest";
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
	it("labels table cells with their column name for mobile restacking", () => {
		const out = renderMarkdown('| a | b"c |\n|---|---|\n| 1 | <b>x</b> |');
		expect(out).toContain('data-label="a"');
		expect(out).toContain('data-label="b&quot;c"');
		expect(out).toContain("<th>a</th>");
		// cell content still goes through the safe inline renderer
		expect(out).not.toMatch(/<td[^>]*><b>/i);
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


describe("in-app session links", () => {
	const g = globalThis as { location?: unknown };
	const saved = g.location;
	afterEach(() => { g.location = saved; });
	it("renders bare hash routes in place", () => {
		const out = renderMarkdown("[hit](#/s/abc/at/3)");
		expect(out).toContain('<a href="#/s/abc/at/3">hit</a>');
		expect(out).not.toContain("_blank");
	});
	it("renders same-origin hash routes as the hash only", () => {
		g.location = { origin: "https://pi.thatsit.app" };
		const out = renderMarkdown("[hit](https://pi.thatsit.app/#/s/abc/at/3)");
		expect(out).toContain('<a href="#/s/abc/at/3">hit</a>');
		expect(out).not.toContain("rel=");
	});
	it("leaves other origins and non-route hashes alone", () => {
		g.location = { origin: "https://pi.thatsit.app" };
		expect(renderMarkdown("[x](https://evil.example/#/s/abc)")).toContain('target="_blank"');
		expect(renderMarkdown("[x](https://pi.thatsit.app/other)")).toContain('target="_blank"');
	});
});
