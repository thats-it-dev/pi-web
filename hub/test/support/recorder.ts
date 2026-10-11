// Collects messages from a stream and lets a test wait for one. `next` is
// ordered (each call starts after the last match); `waitFor` looks at everything.

export class Recorder<T> {
	readonly items: T[] = [];
	private cursor = 0;
	private waiters: Array<{ pred: (item: T) => boolean; ordered: boolean; resolve: (item: T) => void }> = [];

	push(item: T): void {
		this.items.push(item);
		for (const w of [...this.waiters]) {
			if (!w.pred(item)) continue;
			this.waiters.splice(this.waiters.indexOf(w), 1);
			if (w.ordered) this.cursor = this.items.length;
			w.resolve(item);
		}
	}

	next(pred: (item: T) => boolean, timeoutMs = 15_000): Promise<T> {
		const idx = this.items.findIndex((m, i) => i >= this.cursor && pred(m));
		if (idx >= 0) {
			this.cursor = idx + 1;
			return Promise.resolve(this.items[idx]);
		}
		return this.wait(pred, true, timeoutMs);
	}

	waitFor(pred: (item: T) => boolean, timeoutMs = 15_000): Promise<T> {
		const hit = this.items.find(pred);
		return hit !== undefined ? Promise.resolve(hit) : this.wait(pred, false, timeoutMs);
	}

	private wait(pred: (item: T) => boolean, ordered: boolean, timeoutMs: number): Promise<T> {
		return new Promise((resolve, reject) => {
			const w = {
				pred,
				ordered,
				resolve: (item: T) => {
					clearTimeout(timer);
					resolve(item);
				},
			};
			const timer = setTimeout(() => {
				this.waiters.splice(this.waiters.indexOf(w), 1);
				reject(new Error(`timed out waiting for a message; last seen: ${JSON.stringify(this.items.at(-1))?.slice(0, 300)}`));
			}, timeoutMs);
			this.waiters.push(w);
		});
	}
}
