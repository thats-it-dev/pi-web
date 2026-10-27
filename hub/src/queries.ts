// Questions that external services (ring-profile) put to the watch. pi's own
// dialogs are not held here: WatchService derives those from the live handles.
// Each query lives until it is answered, skipped or times out, and its raiser
// hears the outcome exactly once.

import type { QueryOutcome, WatchQuery } from "../../shared/src/protocol.ts";

export interface RaiseInput {
	source: "ring-profile";
	label: string;
	text: string;
	options: string[];
	timeoutMs: number;
	onOutcome: (o: QueryOutcome) => void;
}

export interface QueryDeps {
	now?: () => number;
	setTimer?: typeof setTimeout;
	clearTimer?: typeof clearTimeout;
	onChange: () => void;
}

interface Entry {
	query: WatchQuery;
	onOutcome: (o: QueryOutcome) => void;
	timer: ReturnType<typeof setTimeout>;
	delivered: boolean;
}

export class QueryStore {
	private deps: QueryDeps;
	private entries = new Map<string, Entry>(); // insertion order is oldest first
	private seq = 0;

	constructor(deps: QueryDeps) {
		this.deps = deps;
	}

	raise(input: RaiseInput): WatchQuery {
		const id = `rp:${++this.seq}`;
		const query: WatchQuery = { id, source: input.source, sessionId: null, label: input.label, text: input.text, options: input.options, createdAt: (this.deps.now ?? Date.now)() };
		const timer = (this.deps.setTimer ?? setTimeout)(() => {
			this.resolve(id, { kind: this.entries.get(id)?.delivered ? "expired-delivered" : "expired-undelivered" });
		}, input.timeoutMs);
		this.entries.set(id, { query, onOutcome: input.onOutcome, timer, delivered: false });
		this.deps.onChange();
		return query;
	}

	external(): WatchQuery[] {
		return [...this.entries.values()].map((e) => e.query);
	}

	// False when the query has already ended.
	resolve(id: string, o: QueryOutcome): boolean {
		const e = this.entries.get(id);
		if (!e) return false;
		this.entries.delete(id);
		(this.deps.clearTimer ?? clearTimeout)(e.timer);
		e.onOutcome(o);
		this.deps.onChange();
		return true;
	}

	markDelivered(id: string): void {
		const e = this.entries.get(id);
		if (e) e.delivered = true;
	}

	delivered(id: string): boolean {
		return this.entries.get(id)?.delivered ?? false;
	}

	// Drops every query without telling its raiser.
	close(): void {
		for (const e of this.entries.values()) (this.deps.clearTimer ?? clearTimeout)(e.timer);
		this.entries.clear();
	}
}
