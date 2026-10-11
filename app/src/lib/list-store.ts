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
	private refreshSeq = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private onVisible = () => {
		if (document.visibilityState === "visible") void this.refresh();
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
		let wasDown = false;
		this.stream = this.open<ListMessage>(
			this.api.eventsUrl(),
			(m) => this.apply(m),
			(st) => {
				if (st === "reconnecting") wasDown = true;
				else if (st === "open" && wasDown) {
					wasDown = false;
					void this.refresh(); // events were missed while the stream was down
				}
			},
		);
		this.timer = setInterval(() => void this.refresh(), 30_000);
		if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
	}

	stop(): void {
		this.stream?.close();
		clearInterval(this.timer);
		if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
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
