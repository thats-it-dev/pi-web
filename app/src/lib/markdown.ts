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

const cache = new Map<string, string>();

export function renderMarkdown(src: string): string {
	const hit = cache.get(src);
	if (hit !== undefined) return hit;
	const out = md.parse(src, { async: false }) as string;
	if (cache.size >= 500) cache.delete(cache.keys().next().value as string);
	cache.set(src, out);
	return out;
}
