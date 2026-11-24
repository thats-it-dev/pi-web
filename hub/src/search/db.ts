import { DatabaseSync } from "node:sqlite";
import type { Chunk } from "./chunks.ts";

export interface ChunkRow extends Chunk {
	id: number;
	sessionId: string;
	file: string;
	hasEmbedding: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
	file TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	mtime_ms REAL NOT NULL,
	size INTEGER NOT NULL,
	indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
	id INTEGER PRIMARY KEY,
	session_id TEXT NOT NULL,
	file TEXT NOT NULL,
	ordinal INTEGER NOT NULL,
	piece INTEGER NOT NULL,
	role TEXT NOT NULL,
	ts INTEGER NOT NULL,
	text TEXT NOT NULL,
	embedding BLOB
);
CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id);
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
	text, content='chunks', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
	INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
	INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text ON chunks BEGIN
	INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
	INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

function terms(q: string): string[] {
	return q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** User text → FTS5 MATCH string: quoted terms ANDed, prefix on the last; null when no term survives. */
export function ftsQuery(q: string, join = " "): string | null {
	const t = terms(q);
	if (!t.length) return null;
	return t.map((w, i) => `"${w}"${i === t.length - 1 ? "*" : ""}`).join(join);
}

function toVec(buf: Uint8Array): Float32Array {
	const n = Math.floor(buf.byteLength / 4);
	if (buf.byteOffset % 4 === 0) return new Float32Array(buf.buffer, buf.byteOffset, n);
	return new Float32Array(buf.slice(0, n * 4).buffer);
}

export class SearchDb {
	private db: DatabaseSync;

	constructor(file: string) {
		this.db = new DatabaseSync(file);
		if (file !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
	}

	files(): Map<string, { sessionId: string; mtimeMs: number; size: number }> {
		const out = new Map<string, { sessionId: string; mtimeMs: number; size: number }>();
		for (const r of this.db.prepare("SELECT file, session_id, mtime_ms, size FROM files").all() as any[])
			out.set(r.file, { sessionId: r.session_id, mtimeMs: r.mtime_ms, size: r.size });
		return out;
	}

	private tx(fn: () => void): void {
		this.db.exec("BEGIN");
		try {
			fn();
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	replaceFile(file: string, sessionId: string, cwd: string, mtimeMs: number, size: number, chunks: Chunk[]): void {
		this.tx(() => {
			// Unchanged chunks (same ordinal, piece and text) keep their embedding across a re-index.
			const kept = new Map<string, Uint8Array>();
			for (const r of this.db
				.prepare("SELECT ordinal, piece, text, embedding FROM chunks WHERE file = ? AND embedding IS NOT NULL")
				.all(file) as any[])
				kept.set(`${r.ordinal}\u0000${r.piece}\u0000${r.text}`, r.embedding);
			this.db.prepare("DELETE FROM chunks WHERE file = ?").run(file);
			const ins = this.db.prepare(
				"INSERT INTO chunks (session_id, file, ordinal, piece, role, ts, text, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			);
			for (const c of chunks)
				ins.run(sessionId, file, c.ordinal, c.piece, c.role, c.ts, c.text, kept.get(`${c.ordinal}\u0000${c.piece}\u0000${c.text}`) ?? null);
			this.db
				.prepare(
					"INSERT OR REPLACE INTO files (file, session_id, cwd, mtime_ms, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(file, sessionId, cwd, mtimeMs, size, Date.now());
		});
	}

	removeFile(file: string): void {
		this.tx(() => {
			this.db.prepare("DELETE FROM chunks WHERE file = ?").run(file);
			this.db.prepare("DELETE FROM files WHERE file = ?").run(file);
		});
	}

	/** FTS5 top `limit` chunks; `exclude` drops one session's chunks before the limit (and before the OR fallback). */
	keyword(query: string, limit: number, exclude?: string): { id: number; score: number }[] {
		const run = (m: string) => {
			try {
				const rows = (
					exclude === undefined
						? this.db
								.prepare("SELECT rowid AS id, bm25(chunks_fts) AS r FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY r LIMIT ?")
								.all(m, limit)
						: this.db
								.prepare(
									"SELECT f.rowid AS id, bm25(chunks_fts) AS r FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ? AND c.session_id != ? ORDER BY r LIMIT ?",
								)
								.all(m, exclude, limit)
				) as { id: number; r: number }[];
				return rows.map((x) => ({ id: Number(x.id), score: -x.r }));
			} catch {
				return [];
			}
		};
		const and = ftsQuery(query);
		if (!and) return [];
		const hits = run(and);
		if (hits.length || terms(query).length < 2) return hits;
		return run(ftsQuery(query, " OR ")!);
	}

	pendingEmbeddings(limit: number): { id: number; text: string }[] {
		return (this.db.prepare("SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT ?").all(limit) as any[]).map(
			(r) => ({ id: Number(r.id), text: r.text }),
		);
	}

	setEmbeddings(rows: { id: number; vec: Float32Array }[]): void {
		this.tx(() => {
			const up = this.db.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");
			for (const r of rows) up.run(Buffer.from(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength), r.id);
		});
	}

	allEmbeddings(): { id: number; sessionId: string; vec: Float32Array }[] {
		return (this.db.prepare("SELECT id, session_id, embedding FROM chunks WHERE embedding IS NOT NULL").all() as any[]).map((r) => ({
			id: Number(r.id),
			sessionId: r.session_id,
			vec: toVec(r.embedding),
		}));
	}

	chunks(ids: number[]): ChunkRow[] {
		if (!ids.length) return [];
		const rows = this.db
			.prepare(
				`SELECT id, session_id, file, ordinal, piece, role, ts, text, embedding IS NOT NULL AS has_emb FROM chunks WHERE id IN (${ids.map(() => "?").join(",")})`,
			)
			.all(...ids) as any[];
		const byId = new Map<number, ChunkRow>();
		for (const r of rows)
			byId.set(Number(r.id), {
				id: Number(r.id),
				sessionId: r.session_id,
				file: r.file,
				ordinal: r.ordinal,
				piece: r.piece,
				role: r.role,
				ts: r.ts,
				text: r.text,
				hasEmbedding: !!r.has_emb,
			});
		return ids.flatMap((i) => byId.get(i) ?? []);
	}

	sessionOf(id: number): string {
		const r = this.db.prepare("SELECT session_id FROM chunks WHERE id = ?").get(id) as any;
		return r ? r.session_id : "";
	}

	stats(): { files: number; chunks: number; embedded: number } {
		const n = (sql: string) => Number((this.db.prepare(sql).get() as any).n);
		return {
			files: n("SELECT count(*) AS n FROM files"),
			chunks: n("SELECT count(*) AS n FROM chunks"),
			embedded: n("SELECT count(*) AS n FROM chunks WHERE embedding IS NOT NULL"),
		};
	}

	close(): void {
		this.db.close();
	}
}
