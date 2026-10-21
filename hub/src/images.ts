// Image bytes stay in the hub. Everything sent to the app carries a ref
// (sha256 of the decoded bytes) instead of base64; the app fetches the bytes
// from the image route. Bytes live in a byte-bounded LRU; which refs belong to
// which session is remembered even after the bytes are evicted.

import { createHash } from "node:crypto";
import type { AgentMessage } from "../../shared/src/protocol.ts";
import { imageDimensions, sniffImageType } from "../../shared/src/images.ts";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

interface Entry {
	mimeType: string;
	bytes: Buffer;
}

interface ImageData {
	type: "image";
	data: string;
	mimeType?: unknown;
}

interface Meta {
	ref: string;
	mimeType: string;
	size: number; // decoded bytes
	width?: number;
	height?: number;
}

const isImage = (v: unknown): v is ImageData => {
	const o = v as Record<string, unknown>;
	return o.type === "image" && typeof o.data === "string";
};

export class ImageStore {
	private maxBytes: number;
	private bytes = 0;
	private lru = new Map<string, Entry>(); // insertion order = recency
	private members = new Map<string, Set<string>>();
	private memo = new WeakMap<object, Meta>(); // snapshots resend the same block objects

	constructor(opts: { maxBytes?: number } = {}) {
		this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	}

	// Deep copy of value with every image block's data swapped for a ref.
	outgoing<T>(sessionId: string, value: T): T {
		return this.walk(sessionId, value, true) as T;
	}

	// Record the images in messages without copying them.
	index(sessionId: string, messages: AgentMessage[]): void {
		this.walk(sessionId, messages, false);
	}

	has(sessionId: string, ref: string): boolean {
		return this.members.get(sessionId)?.has(ref) ?? false;
	}

	get(sessionId: string, ref: string): { mimeType: string; bytes: Buffer } | undefined {
		if (!this.has(sessionId, ref)) return undefined;
		const e = this.lru.get(ref);
		if (!e) return undefined;
		this.lru.delete(ref);
		this.lru.set(ref, e);
		return e;
	}

	private walk(sessionId: string, v: unknown, copy: boolean): unknown {
		if (v === null || typeof v !== "object") return v;
		if (isImage(v)) {
			const out = this.record(sessionId, v);
			return copy ? out : v;
		}
		if (Array.isArray(v)) {
			const items = v.map((x) => this.walk(sessionId, x, copy));
			return copy ? items : v;
		}
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) out[k] = this.walk(sessionId, x, copy);
		return copy ? out : v;
	}

	private record(sessionId: string, img: ImageData) {
		let meta = this.memo.get(img);
		let bytes: Buffer | undefined;
		if (!meta) {
			bytes = Buffer.from(img.data, "base64");
			// Trust the bytes over the declared type. Unrecognised bytes are never
			// served under a type the sender chose.
			const sniffed = sniffImageType(bytes);
			const size = sniffed ? imageDimensions(bytes, sniffed) : null;
			meta = {
				ref: createHash("sha256").update(bytes).digest("hex"),
				mimeType: sniffed ?? "application/octet-stream",
				size: bytes.length,
				...(size ?? {}),
			};
			this.memo.set(img, meta);
		}
		let members = this.members.get(sessionId);
		if (!members) this.members.set(sessionId, (members = new Set()));
		members.add(meta.ref);
		const held = this.lru.get(meta.ref);
		if (held) {
			this.lru.delete(meta.ref); // refresh recency, keep the stored entry
			this.lru.set(meta.ref, held);
		} else if (meta.size <= this.maxBytes) {
			this.keep(meta.ref, { mimeType: meta.mimeType, bytes: bytes ?? Buffer.from(img.data, "base64") });
		}
		const { ref, mimeType, width, height } = meta;
		return { type: "image" as const, mimeType, ref, ...(width && height ? { width, height } : {}) };
	}

	private keep(ref: string, entry: Entry): void {
		const old = this.lru.get(ref);
		if (old) {
			this.bytes -= old.bytes.length;
			this.lru.delete(ref);
		}
		this.lru.set(ref, entry);
		this.bytes += entry.bytes.length;
		for (const [k, e] of this.lru) {
			if (this.bytes <= this.maxBytes) break;
			this.lru.delete(k);
			this.bytes -= e.bytes.length;
		}
	}
}
