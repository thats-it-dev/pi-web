import type { SearchHit, SearchResponse } from "../../../shared/src/protocol.ts";
import { HubError, type HubApi } from "./api.ts";

export type SearchState =
	| { status: "idle" }
	| { status: "searching"; query: string }
	| { status: "done"; query: string; hits: SearchHit[]; semantic: boolean }
	| { status: "error"; query: string; message: string };

export interface SearchStoreOptions {
	api: Pick<HubApi, "search">;
	debounceMs?: number;
	minChars?: number;
	limit?: number;
	setTimeout?: typeof setTimeout;
	clearTimeout?: typeof clearTimeout;
}

export function errorMessage(e: unknown): string {
	if (e instanceof HubError) {
		if (e.status === 404) return "Search isn't available on this hub.";
		if (e.status === 0) return "Can't reach the hub.";
	}
	return "Search failed.";
}

export class SearchStore extends EventTarget {
	state: SearchState = { status: "idle" };
	private readonly api: SearchStoreOptions["api"];
	private readonly debounceMs: number;
	private readonly minChars: number;
	private readonly limit: number;
	private readonly setT: typeof setTimeout;
	private readonly clearT: typeof clearTimeout;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private ctl: AbortController | null = null;
	private query = "";

	constructor(opts: SearchStoreOptions) {
		super();
		this.api = opts.api;
		this.debounceMs = opts.debounceMs ?? 300;
		this.minChars = opts.minChars ?? 2;
		this.limit = opts.limit ?? 8;
		this.setT = opts.setTimeout ?? ((...a: Parameters<typeof setTimeout>) => setTimeout(...a)) as typeof setTimeout;
		this.clearT = opts.clearTimeout ?? ((id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id)) as typeof clearTimeout;
	}

	setQuery(q: string): void {
		const query = q.trim();
		// The same text again is a no-op, unless the last try failed: then retyping it retries.
		if (query === this.query && this.state.status !== "idle" && this.state.status !== "error") return;
		this.cancel();
		this.query = query;
		if (query.length < this.minChars) return this.set({ status: "idle" });
		this.set({ status: "searching", query });
		this.timer = this.setT(() => {
			this.timer = null;
			void this.run(query);
		}, this.debounceMs);
	}

	clear(): void {
		this.cancel();
		this.query = "";
		this.set({ status: "idle" });
	}

	private cancel(): void {
		if (this.timer !== null) this.clearT(this.timer);
		this.timer = null;
		this.ctl?.abort();
		this.ctl = null;
	}

	private async run(query: string): Promise<void> {
		const ctl = new AbortController();
		this.ctl = ctl;
		try {
			const r = await this.api.search(query, this.limit, ctl.signal);
			if (ctl.signal.aborted || this.query !== query) return;
			this.set({ status: "done", query, hits: r.hits, semantic: r.semantic });
		} catch (e) {
			if (ctl.signal.aborted || this.query !== query) return;
			this.set({ status: "error", query, message: errorMessage(e) });
		}
	}

	private set(s: SearchState): void {
		this.state = s;
		this.dispatchEvent(new Event("change"));
	}
}
