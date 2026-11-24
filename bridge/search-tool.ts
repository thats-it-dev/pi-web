// search_sessions: lets the model search Michael's past pi-web sessions via the hub's internal /search route.
import { Type } from "typebox";
import type { SearchHit, SearchResponse } from "../shared/src/protocol.ts";

export interface SearchToolDeps {
	fetchFn?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	currentSessionId?: () => string | null;
}

const UNAVAILABLE = "Session search isn't available right now (the hub didn't answer).";

export function formatHits(hits: SearchHit[], appOrigin: string | null): string {
	if (hits.length === 0) return "No past conversation matches.";
	return hits
		.map((h, i) => {
			const title = h.name ?? h.firstPrompt ?? h.sessionId;
			const date = new Date(h.updatedAt).toISOString().slice(0, 10);
			const link = `${appOrigin ?? ""}/#/s/${h.sessionId}/at/${h.ordinal}`.replace(/^\/#/, "#");
			return `${i + 1}. ${title} · ${h.type} · ${date} · ${h.cwd}\n   ${h.role === "user" ? "you" : "pi"}: ${h.snippet}\n   ${link}`;
		})
		.join("\n\n");
}

export function registerSearchTool(pi: { registerTool(t: any): void }, deps: SearchToolDeps = {}): void {
	const env = deps.env ?? process.env;
	pi.registerTool({
		name: "search_sessions",
		label: "Search past sessions",
		description:
			"Find where Michael and pi discussed something before, across his past pi-web sessions. Returns the best matching passages with links to the exact message. Use it before answering \"did we talk about X\" or \"what did we decide about Y\" from memory.",
		parameters: Type.Object({
			query: Type.String({ description: "What to look for, in plain words" }),
			limit: Type.Optional(Type.Number({ description: "How many passages to return (1-8, default 5)", minimum: 1, maximum: 8 })),
		}),
		async execute(_id: string, params: { query: string; limit?: number }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
			const limit = Math.min(8, Math.max(1, Math.round(params.limit ?? 5)));
			const current = ctx?.sessionManager?.getSessionId?.() ?? deps.currentSessionId?.() ?? null;
			const port = env.PI_WEB_INTERNAL_PORT ?? "7879";
			let url = `http://127.0.0.1:${port}/search?q=${encodeURIComponent(params.query)}&limit=${limit}`;
			if (current) url += `&exclude=${encodeURIComponent(current)}`;
			let text: string;
			try {
				const res = await (deps.fetchFn ?? fetch)(url, { signal });
				if (!res.ok) text = UNAVAILABLE;
				else text = formatHits(((await res.json()) as SearchResponse).hits, env.PI_WEB_APP_ORIGIN ?? null);
			} catch {
				text = UNAVAILABLE;
			}
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}
