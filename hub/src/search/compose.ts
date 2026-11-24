// Shared by GET /api/search (server.ts) and the loopback GET /search (internal-server.ts):
// query parsing, and turning the worker's RawHits into SearchHits with the session listing.

import type { SearchHit, SearchResponse, SessionSummary } from "../../../shared/src/protocol.ts";
import type { RawHit } from "./service.ts";

export interface SearchQuery {
	query(q: string, limit: number, exclude?: string): Promise<{ hits: RawHit[]; semantic: boolean }>;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MIN_QUERY = 2;

/** `limit` query param → [1, 20]; missing or not a number → 8. */
export function clampLimit(raw: string | null): number {
	const n = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
	if (Number.isNaN(n)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/** Each hit gets its listing row's name, first prompt, cwd, updatedAt and type; a hit whose session is not listed is dropped. */
export function composeHits(raw: RawHit[], listing: SessionSummary[]): SearchHit[] {
	const byId = new Map(listing.map((s) => [s.id, s]));
	const out: SearchHit[] = [];
	for (const h of raw) {
		const s = byId.get(h.sessionId);
		if (!s) continue;
		out.push({ sessionId: h.sessionId, type: s.type, name: s.name, firstPrompt: s.firstPrompt, cwd: s.cwd, updatedAt: s.updatedAt, ordinal: h.ordinal, role: h.role, snippet: h.snippet, terms: h.terms, semanticOnly: h.semanticOnly });
	}
	return out;
}

/** q, limit (and exclude when allowExclude) from the URL; a query under 2 characters answers empty without asking the search. */
export async function runSearch(search: SearchQuery, listSessions: () => Promise<SessionSummary[]>, params: URLSearchParams, allowExclude = false): Promise<SearchResponse> {
	const q = (params.get("q") ?? "").trim();
	if (q.length < MIN_QUERY) return { hits: [], semantic: false };
	const exclude = allowExclude ? params.get("exclude") || undefined : undefined;
	const [r, listing] = await Promise.all([search.query(q, clampLimit(params.get("limit")), exclude), listSessions()]);
	return { hits: composeHits(r.hits, listing), semantic: r.semantic };
}
