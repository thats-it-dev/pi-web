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
// A load (download included) that has not settled by then counts as failed and starts the retry wait.
const LOAD_TIMEOUT_MS = 3 * 60_000;

/** The transformers embedder's name; the service applies its semantic floor only to this model. */
export const TRANSFORMERS_EMBEDDER_NAME = `transformers:${MODEL}:q8`;

/** Thrown while the model is unavailable (it failed to load, or is waiting out the retry). Already logged by the embedder. */
export class EmbedderUnavailableError extends Error {}

type Extractor = (texts: string[], opts: { pooling: "cls"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

export interface TransformersOptions {
	now?: () => number;
	/** Test seam: replaces the real model load. */
	load?: () => Promise<Extractor>;
	/** Test seam: load timeout; 3 min by default. */
	loadTimeoutMs?: number;
}

/** Lazy CPU embedder (bge-small q8). Nothing loads until the first embed(). */
export function transformersEmbedder(cacheDir: string, log: (m: string) => void, opts: TransformersOptions = {}): Embedder {
	const now = opts.now ?? Date.now;
	const loadTimeoutMs = opts.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
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
			return Promise.reject(new EmbedderUnavailableError(`embedding model failed to load; will retry in ${mins} min`));
		}
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`load timed out after ${Math.round(loadTimeoutMs / 1000)} s`)), loadTimeoutMs);
			timer.unref();
		});
		// A load that never settles (a hung download) is abandoned at the timeout; if it settles later, nobody waits on it.
		const attempt = Promise.race([(opts.load ?? realLoad)(), timeout])
			.finally(() => clearTimeout(timer))
			.catch((err) => {
				failedAt = now();
				loaded = undefined;
				const msg = err instanceof Error ? err.message : String(err);
				log(`embedding model load failed: ${msg}`);
				throw new EmbedderUnavailableError(`embedding model failed to load: ${msg}`);
			});
		loaded = attempt;
		return attempt;
	};

	return {
		name: TRANSFORMERS_EMBEDDER_NAME,
		dims: 384,
		async embed(texts) {
			if (texts.length === 0) return [];
			const extractor = await get();
			const out = await extractor(texts, { pooling: "cls", normalize: true });
			return out.tolist().map((row) => Float32Array.from(row));
		},
	};
}
