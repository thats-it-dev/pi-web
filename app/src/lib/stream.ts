export type StreamStatus = "connecting" | "open" | "reconnecting";

export interface EventSourceLike {
	onopen: ((e: Event) => void) | null;
	onmessage: ((e: MessageEvent) => void) | null;
	onerror: ((e: Event) => void) | null;
	close(): void;
}
export type EventSourceCtor = new (url: string) => EventSourceLike;

// EventSource retries on its own, but without backoff; we close it on error
// and reconnect ourselves (1s doubling to 30s, reset after a good connection).
export function openStream<T>(
	url: string,
	onMessage: (m: T) => void,
	onStatus: (s: StreamStatus) => void,
	ES: EventSourceCtor = EventSource,
	schedule: typeof setTimeout = setTimeout,
): { close(): void } {
	let es: EventSourceLike | null = null;
	let delay = 1000;
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const connect = () => {
		if (closed) return;
		const source = new ES(url);
		es = source;
		source.onopen = () => {
			delay = 1000;
			onStatus("open");
		};
		source.onmessage = (e) => {
			let msg: T;
			try {
				msg = JSON.parse(e.data) as T;
			} catch {
				return; // ignore malformed frames
			}
			onMessage(msg); // handler errors must surface, not vanish
		};
		source.onerror = () => {
			source.close();
			if (es === source) es = null;
			if (closed) return;
			onStatus("reconnecting");
			timer = schedule(connect, delay);
			delay = Math.min(delay * 2, 30_000);
		};
	};
	onStatus("connecting");
	connect();
	return {
		close() {
			closed = true;
			clearTimeout(timer);
			es?.close();
		},
	};
}
