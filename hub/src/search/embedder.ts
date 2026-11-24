import { createHash } from "node:crypto";

export interface Embedder {
	readonly name: string;
	readonly dims: number;
	/** Returns l2-normalized vectors, one per input text. */
	embed(texts: string[]): Promise<Float32Array[]>;
}

export function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Deterministic test embedder: tokens hashed into dims buckets, l2-normalized. */
export function hashEmbedder(dims = 384): Embedder {
	const one = (text: string): Float32Array => {
		const v = new Float32Array(dims);
		for (const tok of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
			const h = createHash("sha256").update(tok).digest();
			v[h.readUInt32BE(0) % dims] += (h[4] & 1) === 0 ? 1 : -1;
		}
		let norm = 0;
		for (const x of v) norm += x * x;
		norm = Math.sqrt(norm);
		if (norm > 0) for (let i = 0; i < dims; i++) v[i] /= norm;
		return v;
	};
	return { name: `hash-${dims}`, dims, embed: async (texts) => texts.map(one) };
}

const MODEL = "Xenova/bge-small-en-v1.5";
const RETRY_MS = 60 * 60_000;

type Extractor = (texts: string[], opts: { pooling: "cls"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

export interface TransformersOptions {
	now?: () => number;
	/** Test seam: replaces the real model load. */
	load?: () => Promise<Extractor>;
}

/** Lazy CPU embedder (bge-small q8). Nothing loads until the first embed(). */
export function transformersEmbedder(cacheDir: string, log: (m: string) => void, opts: TransformersOptions = {}): Embedder {
	const now = opts.now ?? Date.now;
	let loaded: Promise<Extractor> | undefined;
	let failedAt: number | undefined;

	const realLoad = async (): Promise<Extractor> => {
		const { env, pipeline } = await import("@huggingface/transformers");
		env.cacheDir = cacheDir;
		env.allowLocalModels = true;
		log(`loading embedding model ${MODEL}`);
		const p = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
		log("embedding model ready");
		return p as unknown as Extractor;
	};

	const get = (): Promise<Extractor> => {
		if (loaded) return loaded;
		if (failedAt !== undefined && now() - failedAt < RETRY_MS) {
			const mins = Math.ceil((RETRY_MS - (now() - failedAt)) / 60_000);
			return Promise.reject(new Error(`embedding model failed to load; will retry in ${mins} min`));
		}
		const attempt = (opts.load ?? realLoad)().catch((err) => {
			failedAt = now();
			loaded = undefined;
			log(`embedding model load failed: ${err instanceof Error ? err.message : String(err)}`);
			throw err;
		});
		loaded = attempt;
		return attempt;
	};

	return {
		name: `transformers:${MODEL}:q8`,
		dims: 384,
		async embed(texts) {
			if (texts.length === 0) return [];
			const extractor = await get();
			const out = await extractor(texts, { pooling: "cls", normalize: true });
			return out.tolist().map((row) => Float32Array.from(row));
		},
	};
}
