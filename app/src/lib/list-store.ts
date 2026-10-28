import type { ListMessage, SessionSummary } from "../../../shared/src/protocol.ts";
import type { HubApi } from "./api.ts";
import { openStream } from "./stream.ts";

const CACHE_KEY = "pi-web:sessions";

function readCache(): { sessions: SessionSummary[]; home: string } | null {
	try {
		return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
	} catch {
		return null;
	}
}

function writeCache(v: { sessions: SessionSummary[]; home: string }): void {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify(v));
	} catch {}
}

export class ListStore extends EventTarget {
	sessions: SessionSummary[] = [];
	home = "";
	error: string | null = null;
	loaded = false;
	private api: Pick<HubApi, "sessions" | "eventsUrl">;
	private open: typeof openStream;
	private stream: { close(): void } | null = null;
	private pending: { close(): void } | null = null; // a replacement stream not yet open
	private viewing: string | null = null; // the session on screen, reported to the hub
	private refreshSeq = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	// The events stream is held only while the app is visible: only a stream
	// opened with `?viewing=<id>` makes the hub hold back pushes, and only for that session.
	private onVisible = () => {
		if (document.visibilityState !== "visible") return this.closeEvents();
		if (this.stream) return;
		this.openEvents();
		void this.refresh(); // events were missed while hidden
	};

	constructor(api: Pick<HubApi, "sessions" | "eventsUrl">, open: typeof openStream = openStream) {
		super();
		this.api = api;
		this.open = open;
		const cached = readCache();
		if (cached) {
			this.sessions = cached.sessions;
			this.home = cached.home;
		}
	}

	start(): void {
		void this.refresh();
		if (typeof document === "undefined" || document.visibilityState === "visible") this.openEvents();
		this.timer = setInterval(() => void this.refresh(), 30_000);
		if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
	}

	stop(): void {
		this.closeEvents();
		clearInterval(this.timer);
		if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
	}

	// Switches the stream to report the new session. Make-before-break: the old
	// stream stays until the new one is open, so the hub's viewer count never
	// drops to zero mid-switch (it would treat the app as closed).
	setViewing(id: string | null): void {
		if (id === this.viewing) return;
		this.viewing = id;
		if (!this.stream) return; // hidden or stopped: the next open carries it
		this.pending?.close(); // a switch still in flight is superseded
		this.pending = null;
		this.openEvents(true);
	}

	private openEvents(swap = false): void {
		let wasDown = false;
		let handle: { close(): void } | null = null;
		let opened = false;
		const promote = () => {
			if (!handle || this.pending !== handle) return;
			this.pending = null;
			this.stream?.close();
			this.stream = handle;
		};
		handle = this.open<ListMessage>(
			this.api.eventsUrl(this.viewing),
			(m) => this.apply(m),
			(st) => {
				if (st === "reconnecting") wasDown = true;
				else if (st === "open") {
					opened = true;
					if (swap) promote();
					if (wasDown) {
						wasDown = false;
						void this.refresh(); // events were missed while the stream was down
					}
				}
			},
		);
		if (swap) {
			this.pending = handle;
			if (opened) promote(); // opened before open() returned
		} else this.stream = handle;
	}

	private closeEvents(): void {
		this.pending?.close();
		this.pending = null;
		this.stream?.close();
		this.stream = null;
	}

	async refresh(): Promise<void> {
		const seq = ++this.refreshSeq;
		try {
			const r = await this.api.sessions();
			if (seq !== this.refreshSeq) return; // a newer refresh superseded this one
			this.sessions = r.sessions;
			this.home = r.home;
			this.error = null;
			writeCache(r);
		} catch (e) {
			if (seq !== this.refreshSeq) return;
			this.error = (e as Error).message;
		}
		this.loaded = true;
		this.changed();
	}

	apply(m: ListMessage): void {
		if (m.type === "session_list_changed") return void this.refresh();
		const s = this.sessions.find((x) => x.id === m.sessionId);
		if (!s) {
			if (m.live) void this.refresh();
			return;
		}
		const finished = s.state === "running" && m.state !== "running";
		Object.assign(s, { live: m.live, handleKind: m.handleKind, state: m.state });
		this.changed();
		if (finished) void this.refresh(); // pick up the new title, time and context size
	}

	private changed(): void {
		this.dispatchEvent(new Event("change"));
	}
}
