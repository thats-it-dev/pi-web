import { type TemplateResult, css, html, nothing } from "lit";
import { CODE_ICON, MESSAGE_CIRCLE_ICON } from "@thatsit/kit";
import type { SearchHit } from "../../../shared/src/protocol.ts";
import { abbreviateCwd, relativeTime, sessionTitle } from "../lib/format.ts";
import type { SearchState } from "../lib/search-store.ts";
import { hrefFor } from "../lib/route.ts";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text nodes and <mark> elements only; case-insensitive, non-overlapping, longest term first. */
export function highlight(text: string, terms: string[]): TemplateResult {
	const ts = [...new Set(terms.filter((t) => t.length > 0))].sort((a, b) => b.length - a.length);
	if (ts.length === 0) return html`${text}`;
	const re = new RegExp(`(${ts.map(escapeRe).join("|")})`, "gi");
	const parts = text.split(re); // odd indexes are matches
	return html`${parts.map((p, i) => (i % 2 === 1 ? html`<mark>${p}</mark>` : p))}`;
}

function row(h: SearchHit, home: string): TemplateResult {
	const foot = h.semanticOnly ? "topic match" : `${h.role === "user" ? "you" : "pi"} · ${abbreviateCwd(h.cwd, home)}`;
	return html`<a class="row hit" href=${hrefFor({ name: "session", id: h.sessionId, at: h.ordinal })}>
		<span class="ty">${h.type === "chat" ? MESSAGE_CIRCLE_ICON : CODE_ICON}</span>
		<span class="t">${sessionTitle({ name: h.name, firstPrompt: h.firstPrompt })}</span>
		<span class="ago">${relativeTime(h.updatedAt)}</span>
		<span class="snip">${highlight(h.snippet, h.terms)}</span>
		<span class="foot">${foot}</span>
	</a>`;
}

export function searchHits(state: SearchState, home: string): TemplateResult | typeof nothing {
	if (state.status === "idle") return nothing;
	let body: TemplateResult | TemplateResult[];
	if (state.status === "searching") body = html`<p class="status"><span class="pulse"></span>searching…</p>`;
	else if (state.status === "error") body = html`<p class="status">${state.message}</p>`;
	else if (state.hits.length === 0) body = html`<p class="status">Nothing in conversations.</p>`;
	else body = state.hits.map((h) => row(h, home));
	return html`<section class="hits"><h2 class="label">In conversations</h2>${body}</section>`;
}

export const searchHitsStyles = css`
	.hit { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; column-gap: 8px; row-gap: 2px; align-items: baseline; padding: 7px 16px 7px 14px; border-left: 2px solid transparent; color: var(--text-primary); }
	.hit:hover { background: var(--panel); }
	.hit .ty { display: flex; align-items: center; color: var(--text-muted); }
	.hit .ty svg { width: 12px; height: 12px; }
	.hit .t { font-weight: 500; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.hit .ago { font-size: 0.72rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
	.snip { grid-column: 2 / 4; font-size: 0.8rem; color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
	.snip mark { background: none; color: var(--text-primary); font-weight: 600; text-decoration: underline; text-decoration-color: var(--primary); text-decoration-thickness: 2px; text-underline-offset: 2px; }
	.foot { grid-column: 2 / 4; font-size: 0.72rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.hits .status { display: flex; align-items: center; gap: 8px; margin: 0; padding: 8px 16px; font-size: 0.9rem; color: var(--text-secondary); }
	.pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--primary); animation: hit-pulse 1.2s ease-in-out infinite; }
	@keyframes hit-pulse { 50% { opacity: 0.3; } }
	@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
`;
