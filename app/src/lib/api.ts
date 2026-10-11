import type { AgentMessage, AppCommand, CommandResult, HealthInfo, SessionSummary } from "../../../shared/src/protocol.ts";

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

export class HubApi {
	readonly base: string;

	constructor(base: string) {
		this.base = base.replace(/\/+$/, "");
	}

	private async req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		} catch {
			throw new HubError(0, "Can't reach the hub. Is Tailscale connected?");
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new HubError(res.status, (data as { error?: string }).error ?? `The hub answered ${res.status}.`);
		return data as T;
	}

	health() {
		return this.req<HealthInfo>("GET", "/api/health");
	}
	sessions() {
		return this.req<{ sessions: SessionSummary[]; home: string }>("GET", "/api/sessions");
	}
	cwds() {
		return this.req<{ cwds: string[]; home: string }>("GET", "/api/cwds");
	}
	createSession(cwd: string) {
		return this.req<{ sessionId: string }>("POST", "/api/sessions", { cwd });
	}
	history(id: string) {
		return this.req<HistoryResponse>("GET", `/api/sessions/${encodeURIComponent(id)}/history`);
	}
	command(id: string, cmd: AppCommand) {
		return this.req<{ result: CommandResult; sessionId: string }>("POST", `/api/sessions/${encodeURIComponent(id)}/commands`, cmd);
	}
	close(id: string) {
		return this.req<{ ok: true }>("POST", `/api/sessions/${encodeURIComponent(id)}/close`, {});
	}
	streamUrl(id: string) {
		return `${this.base}/api/sessions/${encodeURIComponent(id)}/stream`;
	}
	eventsUrl() {
		return `${this.base}/api/events`;
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
