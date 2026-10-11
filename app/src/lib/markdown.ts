// Model and tool output is untrusted, and this app can run shell commands, so
// raw HTML is escaped and only http(s)/mailto links survive. Images become
// links so nothing loads from third-party hosts.

import { Marked, type Tokens } from "marked";

const SAFE_URL = /^(https?:|mailto:)/i;
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);
const link = (href: string, inner: string) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;

const md = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		html(token: Tokens.HTML | Tokens.Tag) {
			return esc(token.text);
		},
		link(token: Tokens.Link) {
			const inner = this.parser.parseInline(token.tokens);
			return SAFE_URL.test(token.href) ? link(token.href, inner) : inner;
		},
		image(token: Tokens.Image) {
			const label = esc(token.text || token.href);
			return SAFE_URL.test(token.href) ? link(token.href, label) : label;
		},
	},
});

// Renders without caching: for text that is still streaming, where every
// delta is a new string that will never be asked for again.
export function renderMarkdownUncached(src: string): string {
	return md.parse(src, { async: false }) as string;
}

const CACHE_SIZE = 500;
const cache = new Map<string, string>(); // insertion order = recency, oldest first

// Text-keyed LRU for completed text.
export function renderMarkdown(src: string): string {
	const hit = cache.get(src);
	if (hit !== undefined) {
		cache.delete(src);
		cache.set(src, hit);
		return hit;
	}
	const out = renderMarkdownUncached(src);
	if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
	cache.set(src, out);
	return out;
}
