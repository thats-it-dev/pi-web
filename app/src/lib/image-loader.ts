// Fetches image bytes once per ref and hands out blob: URLs. One loader per
// session view; dispose() revokes every URL when the view goes away.
export class ImageLoader {
	private urls = new Map<string, Promise<string>>();
	private settled = new Set<string>();
	private disposed = false;

	private fetchBlob: (ref: string) => Promise<Blob>;
	private createUrl: (b: Blob) => string;
	private revokeUrl: (u: string) => void;

	constructor(
		fetchBlob: (ref: string) => Promise<Blob>,
		createUrl: (b: Blob) => string = (b) => URL.createObjectURL(b),
		revokeUrl: (u: string) => void = (u) => URL.revokeObjectURL(u),
	) {
		this.fetchBlob = fetchBlob;
		this.createUrl = createUrl;
		this.revokeUrl = revokeUrl;
	}

	load(ref: string): Promise<string> {
		const hit = this.urls.get(ref);
		if (hit) return hit;
		const p = this.fetchBlob(ref).then((blob) => {
			const url = this.createUrl(blob);
			if (this.disposed) this.revokeUrl(url);
			else this.settled.add(url);
			return url;
		});
		this.urls.set(ref, p);
		// Don't cache failures: a later load retries.
		p.catch(() => {
			if (this.urls.get(ref) === p) this.urls.delete(ref);
		});
		return p;
	}

	dispose(): void {
		this.disposed = true;
		for (const u of this.settled) this.revokeUrl(u);
		this.settled.clear();
		this.urls.clear();
	}
}
