// Session search: keeps the store in step with the session files (sweep/poke), embeds pending
// chunks, and answers queries by fusing FTS5 and vector rankings, one hit per session.

import { readFile, stat } from "node:fs/promises";
import { chunkSession } from "./chunks.ts";
import type { SearchDb } from "./db.ts";
import type { Embedder } from "./embedder.ts";
import { cosineTopK, queryWords, rrf, snippet, termsIn } from "./rank.ts";

export interface RawHit {
	sessionId: string;
	ordinal: number;
	role: "user" | "assistant";
	snippet: string;
	terms: string[];
	semanticOnly: boolean;
	score: number;
}

export interface ListedSession {
	id: string;
	file: string;
	cwd: string;
	name: string | null;
	firstPrompt: string | null;
	updatedAt: number;
	parentSession: string | null;
}

export interface SearchServiceOptions {
	db: SearchDb;
	embedder: Embedder | null;
	lookup: () => Promise<ListedSession[]>;
	log?: (m: string) => void;
	embedBatch?: number;
	debounceMs?: number;
}

const TOP = 40;

// Query words that carry no meaning on their own. A query made only of these returns nothing
// (FTS5 has no stopword list, so "the" would otherwise match nearly every chunk).
const STOPWORDS = new Set(
	(
		"a an and are as be been but by can could did do does for from had has have he her his how i if in into is it its " +
		"me my no not of on or our she so than that the their them then there these they this to too us was we were what " +
		"when where which who why will with would you your"
	).split(" "),
);

/** Query text → the words worth matching: queryWords minus stopwords. */
export function contentWords(q: string): string[] {
	return queryWords(q).filter((w) => !STOPWORDS.has(w));
}

type Vecs = { id: number; sessionId: string; vec: Float32Array }[];

export class SearchService {
	private db: SearchDb;
	private embedder: Embedder | null;
	private lookup: () => Promise<ListedSession[]>;
	private log: (m: string) => void;
	private embedBatch: number;
	private debounceMs: number;
	private vecs: Vecs | null = null;
	private inflight: Promise<{ indexed: number; removed: number }> | null = null;
	private queued: Promise<{ indexed: number; removed: number }> | null = null;
	private embedding: Promise<number> | null = null;
	private timer: NodeJS.Timeout | null = null;

	constructor(opts: SearchServiceOptions) {
		this.db = opts.db;
		this.embedder = opts.embedder;
		this.lookup = opts.lookup;
		this.log = opts.log ?? (() => {});
		this.embedBatch = Math.max(1, opts.embedBatch ?? 32);
		this.debounceMs = opts.debounceMs ?? 2000;
	}

	/** One sweep at a time; a call during a sweep waits for it and then runs once more (shared by all such callers). */
	sweep(): Promise<{ indexed: number; removed: number }> {
		if (!this.inflight) {
			const run = this.runSweep().finally(() => {
				if (this.inflight === run) this.inflight = null;
			});
			this.inflight = run;
			return run;
		}
		if (!this.queued) {
			this.queued = this.inflight
				.catch(() => {})
				.then(() => {
					this.queued = null;
					return this.sweep();
				});
		}
		return this.queued;
	}

	private async runSweep(): Promise<{ indexed: number; removed: number }> {
		const listed = await this.lookup();
		const known = this.db.files();
		const seen = new Set<string>();
		const changed: { entry: ListedSession; mtimeMs: number; size: number }[] = [];
		let removed = 0;
		for (const entry of listed) {
			let st;
			try {
				st = await stat(entry.file);
			} catch {
				continue; // vanished between listing and stat: purged below
			}
			seen.add(entry.file);
			const k = known.get(entry.file);
			if (!k || k.mtimeMs !== st.mtimeMs || k.size !== st.size) changed.push({ entry, mtimeMs: st.mtimeMs, size: st.size });
		}
		for (const file of known.keys()) {
			if (seen.has(file)) continue;
			this.db.removeFile(file);
			this.vecs = null;
			removed++;
		}
		// Newest first: their chunks get the lowest new ids, and pendingEmbeddings goes by id.
		changed.sort((a, b) => b.mtimeMs - a.mtimeMs);
		let indexed = 0;
		for (const { entry, mtimeMs, size } of changed) {
			let text: string;
			try {
				text = await readFile(entry.file, "utf8");
			} catch {
				if (known.has(entry.file)) {
					this.db.removeFile(entry.file);
					this.vecs = null;
					removed++;
				}
				continue;
			}
			// Stored with the stat taken before the read: if the file grew in between, the next sweep re-reads it.
			const chunked = chunkSession(text);
			this.db.replaceFile(entry.file, entry.id, entry.cwd, mtimeMs, size, chunked?.chunks ?? []);
			this.vecs = null;
			indexed++;
		}
		if (indexed || removed) this.log(`search: indexed ${indexed}, removed ${removed}`);
		await this.embedPending();
		return { indexed, removed };
	}

	embedPending(): Promise<number> {
		if (!this.embedder) return Promise.resolve(0);
		if (!this.embedding) this.embedding = this.runEmbed(this.embedder).finally(() => (this.embedding = null));
		return this.embedding;
	}

	private async runEmbed(embedder: Embedder): Promise<number> {
		let count = 0;
		for (;;) {
			const batch = this.db.pendingEmbeddings(this.embedBatch);
			if (!batch.length) break;
			let vecs: Float32Array[];
			try {
				vecs = await embedder.embed(batch.map((b) => b.text));
			} catch (err) {
				this.log(`search: embedding failed: ${err instanceof Error ? err.message : String(err)}`);
				break;
			}
			const rows = batch.slice(0, vecs.length).map((b, i) => ({ id: b.id, vec: vecs[i] }));
			if (!rows.length) break;
			this.db.setEmbeddings(rows);
			this.vecs = null;
			count += rows.length;
			if (rows.length < batch.length) break;
			// A sweep is waiting (a poke or a direct call): let it re-index now; it resumes the backlog after.
			if (this.queued) break;
		}
		return count;
	}

	/** Schedules a sweep debounceMs from the first poke; further pokes before it fires join it. */
	poke(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.sweep().catch((err) => this.log(`search: sweep failed: ${err instanceof Error ? err.message : String(err)}`));
		}, this.debounceMs);
		this.timer.unref();
	}

	private vectors(): Vecs {
		if (!this.vecs) this.vecs = this.db.allEmbeddings();
		return this.vecs;
	}

	async query(q: string, limit: number, exclude?: string): Promise<{ hits: RawHit[]; semantic: boolean }> {
		const words = contentWords(q);
		if (!words.length || limit <= 0) return { hits: [], semantic: false };
		const keyword = this.db.keyword(words.join(" "), TOP, exclude);
		let vector: { id: number; score: number }[] = [];
		let semantic = false;
		if (this.embedder && this.vectors().length) {
			try {
				const [qv] = await this.embedder.embed([q]);
				if (qv) {
					const rows = exclude === undefined ? this.vectors() : this.vectors().filter((r) => r.sessionId !== exclude);
					vector = cosineTopK(qv, rows, TOP);
					semantic = true;
				}
			} catch (err) {
				this.log(`search: query embedding failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const fused = rrf(semantic ? [keyword, vector] : [keyword]);
		if (!fused.length) return { hits: [], semantic };
		const live = new Set((await this.lookup()).map((s) => s.id));
		const inKeyword = new Set(keyword.map((k) => k.id));
		const score = new Map(fused.map((f) => [f.id, f.score]));
		const hits: RawHit[] = [];
		const taken = new Set<string>();
		for (const row of this.db.chunks(fused.map((f) => f.id))) {
			if (taken.has(row.sessionId) || row.sessionId === exclude || !live.has(row.sessionId)) continue;
			taken.add(row.sessionId);
			hits.push({
				sessionId: row.sessionId,
				ordinal: row.ordinal,
				role: row.role,
				snippet: snippet(row.text, words),
				terms: termsIn(row.text, words),
				semanticOnly: !inKeyword.has(row.id),
				score: score.get(row.id)!,
			});
			if (hits.length >= limit) break;
		}
		return { hits, semantic };
	}

	stats(): { files: number; chunks: number; embedded: number; semantic: boolean } {
		const s = this.db.stats();
		return { ...s, semantic: !!this.embedder && s.embedded > 0 };
	}
}
