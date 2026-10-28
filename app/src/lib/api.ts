import type { AgentMessage, AppCommand, CommandResult, DefaultsInfo, HealthInfo, PushSubscriptionInfo, SessionSummary, ThinkingLevel, UpdateResult, UpdateStatus } from "../../../shared/src/protocol.ts";

export class HubError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface HistoryResponse {
	messages: AgentMessage[];
	live: boolean;
	cwd: string;
	name?: string | null;
	error?: string | null;
}

export interface FileEntry {
	path: string; // relative to the session's cwd
	dir: boolean;
}

export class HubApi {
	readonly base: string;

	constructor(base: string) {
		this.base = base.replace(/\/+$/, "");
	}

	private async req<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, body === undefined ? { method, signal } : { method, signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		} catch (e) {
			if (signal?.aborted) throw e;
			throw new HubError(0, "Can't reach the hub. Is Tailscale connected?");
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new HubError(res.status, (data as { error?: string }).error ?? `The hub answered ${res.status}.`);
		return data as T;
	}

	health() {
		return this.req<HealthInfo>("GET", "/api/health");
	}
	updateStatus() {
		return this.req<UpdateStatus>("GET", "/api/update");
	}
	update(force = false) {
		return this.req<UpdateResult>("POST", "/api/update", { force });
	}
	sessions() {
		return this.req<{ sessions: SessionSummary[]; home: string }>("GET", "/api/sessions");
	}
	cwds() {
		return this.req<{ cwds: string[]; home: string }>("GET", "/api/cwds");
	}
	defaults() {
		return this.req<DefaultsInfo>("GET", "/api/defaults");
	}
	createSession(o: { cwd: string; model?: { provider: string; modelId: string }; thinking?: ThinkingLevel | null }) {
		const { thinking, ...rest } = o;
		return this.req<{ sessionId: string }>("POST", "/api/sessions", thinking ? { ...rest, thinking } : rest);
	}
	history(id: string) {
		return this.req<HistoryResponse>("GET", `/api/sessions/${encodeURIComponent(id)}/history`);
	}
	command(id: string, cmd: AppCommand) {
		return this.req<{ result: CommandResult; sessionId: string }>("POST", `/api/sessions/${encodeURIComponent(id)}/commands`, cmd);
	}
	files(id: string, q: string, signal?: AbortSignal) {
		return this.req<{ files: FileEntry[] }>("GET", `/api/sessions/${encodeURIComponent(id)}/files?q=${encodeURIComponent(q)}`, undefined, signal);
	}
	close(id: string) {
		return this.req<{ ok: true }>("POST", `/api/sessions/${encodeURIComponent(id)}/close`, {});
	}
	pushSubscribe(sub: PushSubscriptionInfo) {
		return this.req<{ ok: true }>("POST", "/api/push/subscribe", sub);
	}
	pushUnsubscribe(endpoint: string) {
		return this.req<{ ok: true }>("POST", "/api/push/unsubscribe", { endpoint });
	}
	streamUrl(id: string) {
		return `${this.base}/api/sessions/${encodeURIComponent(id)}/stream`;
	}
	// viewing: the session on screen, so the hub holds back its pushes.
	eventsUrl(viewing?: string | null) {
		return `${this.base}/api/events${viewing ? `?viewing=${encodeURIComponent(viewing)}` : ""}`;
	}

	// Plain fetch (not req) because the body is wanted as a Blob.
	async image(sessionId: string, ref: string): Promise<Blob> {
		const res = await fetch(`${this.base}/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(ref)}`).catch(() => null);
		if (!res?.ok) throw new HubError(res?.status ?? 0, "The image couldn't be loaded.");
		return res.blob();
	}

	// Cross-origin navigations carry no Origin header, so the hub would refuse a
	// plain link; fetch the file and hand it to the browser as a download.
	async downloadExport(name: string): Promise<void> {
		const res = await fetch(`${this.base}/api/exports/${encodeURIComponent(name)}`).catch(() => null);
		if (!res?.ok) throw new HubError(res?.status ?? 0, "The export couldn't be downloaded.");
		const url = URL.createObjectURL(await res.blob());
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}
}
