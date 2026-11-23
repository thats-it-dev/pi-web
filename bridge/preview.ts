// The preview tool's engine: one live preview per session (a Vite dev server or a static
// folder), exposed on the tailnet through `tailscale serve` on a port in 10600-10649.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { freeLocalPort, isListening, pickServePort, SERVE_PORT_MAX, SERVE_PORT_MIN } from "./ports.ts";
import { startStaticServer, type StaticServer } from "./static-server.ts";
import { Tailscale } from "./tailscale.ts";

export interface PreviewParams {
	cwd?: string;
	dir?: string;
	file?: string;
	stop?: boolean;
}
export type PreviewKind = "dev" | "static";
export interface PreviewDetails {
	url: string;
	label: string;
	kind: PreviewKind;
	port: number;
	root: string;
}
export interface PreviewStopped {
	stopped: true;
}
export interface ToolResult {
	content: { type: "text"; text: string }[];
	details?: PreviewDetails | PreviewStopped | { error: string };
	isError?: boolean;
}
export interface DevProcess {
	pid: number;
	kill(): void;
	exited: Promise<number | null>;
}
export interface PreviewDeps {
	tailscale: Tailscale;
	freeLocalPort: () => Promise<number>;
	isListening: (port: number) => Promise<boolean>;
	startStatic: (root: string) => Promise<StaticServer>;
	/** Detached `npm run dev -- --host 127.0.0.1 --port <port> --strictPort`, output to `log`. */
	spawnDev: (cwd: string, port: number, host: string, log: string) => DevProcess;
	/** True once GET http://127.0.0.1:<port>/ answers with a status < 500. */
	waitHealthy: (port: number, timeoutMs: number) => Promise<boolean>;
	logDir: string;
	now?: () => number;
	/** Home folder for mockup scratch dirs; defaults to os.homedir(). */
	home?: string;
}

export const HEALTH_TIMEOUT_MS = 30_000;
export const STATUS_KEY = "preview";
const LOG_TAIL_LINES = 20;

interface Active {
	details: PreviewDetails;
	localPort: number;
	dead: boolean;
	close(): Promise<void>;
}

function text(t: string): { type: "text"; text: string }[] {
	return [{ type: "text", text: t }];
}

function errorResult(message: string): ToolResult {
	return { content: text(message), details: { error: message }, isError: true };
}

function openText(prefix: string, d: PreviewDetails): string {
	const what = d.kind === "dev" ? "dev server" : "static folder";
	return `${prefix} ${d.url} (${d.label}, ${what} with live reload). Michael sees it in pi-web's Preview panel: tell him to take a look and ask what to change, then end your turn.`;
}

function readTail(path: string, lines: number): string {
	let log = "";
	try {
		log = readFileSync(path, "utf8");
	} catch {
		return "";
	}
	return log.replace(/\n+$/, "").split("\n").slice(-lines).join("\n");
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function hasDevScript(root: string): boolean {
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		return typeof pkg?.scripts?.dev === "string" && pkg.scripts.dev.length > 0;
	} catch {
		return false;
	}
}

export class PreviewManager {
	private deps: PreviewDeps;
	private active: Active | null = null;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(deps: PreviewDeps) {
		this.deps = deps;
	}

	static mockupDir(home: string, sessionId: string): string {
		const dir = join(home, ".pi", "agent", "tmp", "previews", sessionId);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	current(): PreviewDetails | null {
		if (!this.active || this.active.dead) return null;
		return { ...this.active.details };
	}

	statusText(): string | undefined {
		const d = this.current();
		return d ? `preview ${d.label} :${d.port}` : undefined;
	}

	/** Runs one action at a time so two calls never race for a port. */
	run(params: PreviewParams, sessionCwd: string, sessionId: string): Promise<ToolResult> {
		const next = this.queue.then(() => this.runNow(params, sessionCwd, sessionId));
		this.queue = next.catch(() => {});
		return next;
	}

	stop(): Promise<void> {
		const next = this.queue.then(() => this.stopNow());
		this.queue = next.catch(() => {});
		return next;
	}

	private async runNow(params: PreviewParams, sessionCwd: string, sessionId: string): Promise<ToolResult> {
		try {
			if (params.stop) {
				await this.stopNow();
				return { content: text("Preview stopped."), details: { stopped: true } };
			}
			if (params.cwd !== undefined) return await this.runDev(resolve(sessionCwd, params.cwd));
			if (params.dir !== undefined) {
				const root = resolve(sessionCwd, params.dir);
				if (!isDir(root)) return errorResult(`${root} is not a folder.`);
				return await this.runStatic(root, basename(root));
			}
			if (params.file !== undefined) {
				const file = resolve(sessionCwd, params.file);
				if (!existsSync(file)) return errorResult(`${file} does not exist.`);
				return await this.runStatic(dirname(file), basename(file));
			}
			const dir = PreviewManager.mockupDir(this.deps.home ?? homedir(), sessionId);
			return { content: text(`Mockup folder: ${dir}. Write index.html there, then call preview({ dir: "${dir}" }).`) };
		} catch (e) {
			return errorResult(`Preview failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async runDev(root: string): Promise<ToolResult> {
		if (!hasDevScript(root)) {
			return errorResult(`${root} has no dev script; pass dir for a static folder or cwd of a Vite app.`);
		}
		const cur = this.active;
		if (cur && !cur.dead && cur.details.kind === "dev" && cur.details.root === root && (await this.deps.isListening(cur.localPort))) {
			return { content: text(openText("Preview already open at", cur.details)), details: { ...cur.details } };
		}
		const host = await this.deps.tailscale.host();
		return this.expose(root, basename(root), "dev", host, async (servePort) => {
			const localPort = await this.deps.freeLocalPort();
			mkdirSync(this.deps.logDir, { recursive: true });
			const log = join(this.deps.logDir, `preview-${servePort}.log`);
			const proc = this.deps.spawnDev(root, localPort, host, log);
			let exited = false;
			proc.exited.then(
				() => (exited = true),
				() => (exited = true),
			);
			const healthy = await Promise.race([
				this.deps.waitHealthy(localPort, HEALTH_TIMEOUT_MS),
				proc.exited.then(
					() => false,
					() => false,
				),
			]);
			if (!healthy) {
				proc.kill();
				const tail = readTail(log, LOG_TAIL_LINES);
				const why = exited ? "exited before it answered" : `did not answer within ${HEALTH_TIMEOUT_MS / 1000}s`;
				throw new Error(`The dev server in ${root} ${why}.${tail ? `\nLast log lines:\n${tail}` : ""}`);
			}
			return {
				localPort,
				close: async () => proc.kill(),
				onExit: proc.exited,
			};
		});
	}

	private async runStatic(root: string, label: string): Promise<ToolResult> {
		const host = await this.deps.tailscale.host();
		return this.expose(root, label, "static", host, async () => {
			const server = await this.deps.startStatic(root);
			return { localPort: server.port, close: () => server.close() };
		});
	}

	/** Stop any current preview, reconcile the range, pick a serve port, start the server, add the entry. */
	private async expose(
		root: string,
		label: string,
		kind: PreviewKind,
		host: string,
		start: (servePort: number) => Promise<{ localPort: number; close(): Promise<void>; onExit?: Promise<unknown> }>,
	): Promise<ToolResult> {
		await this.stopNow();
		const ts = this.deps.tailscale;
		await ts.reconcile({ min: SERVE_PORT_MIN, max: SERVE_PORT_MAX }, this.deps.isListening);
		const port = pickServePort((await ts.entries()).map((e) => e.port));
		if (port === null) return errorResult(`No free preview port in ${SERVE_PORT_MIN}-${SERVE_PORT_MAX}.`);
		let started;
		try {
			started = await start(port);
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
		try {
			await ts.add(port, started.localPort);
		} catch (e) {
			await started.close().catch(() => {});
			throw e;
		}
		const details: PreviewDetails = { url: `https://${host}:${port}`, label, kind, port, root };
		const active: Active = { details, localPort: started.localPort, dead: false, close: started.close };
		this.active = active;
		started.onExit?.then(
			() => (active.dead = true),
			() => (active.dead = true),
		);
		return { content: text(openText("Preview open at", details)), details: { ...details } };
	}

	private async stopNow(): Promise<void> {
		const cur = this.active;
		if (!cur) return;
		this.active = null;
		try {
			await cur.close();
		} catch {
			// already gone
		}
		// Only remove the entry while it still points at our server: once our server died, another
		// session's reconcile may have reassigned the port, and that exposure is not ours to tear down.
		try {
			const ts = this.deps.tailscale;
			const ours = `http://127.0.0.1:${cur.localPort}`;
			const entry = (await ts.entries()).find((e) => e.port === cur.details.port);
			if (entry && entry.target.replace(/\/$/, "") === ours) await ts.remove(cur.details.port);
		} catch {
			// a stale entry is reconciled on the next start
		}
	}
}

/** Polls GET http://127.0.0.1:<port>/ until any status < 500 answers, or the timeout passes. */
export async function waitHealthy(port: number, timeoutMs: number, intervalMs = 250): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(Math.max(intervalMs, 1000)) });
			await res.body?.cancel().catch(() => {});
			if (res.status < 500) return true;
		} catch {
			// not up yet
		}
		if (Date.now() + intervalMs > deadline) return false;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

export function spawnDev(cwd: string, port: number, host: string, log: string): DevProcess {
	const fd = openSync(log, "w");
	let child;
	try {
		child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
			cwd,
			detached: true,
			stdio: ["ignore", fd, fd],
			env: { ...process.env, __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: host },
		});
	} finally {
		closeSync(fd);
	}
	child.unref();
	const pid = child.pid ?? 0;
	const exited = new Promise<number | null>((done) => {
		child.once("error", () => done(127));
		child.once("exit", (code) => done(code));
	});
	return {
		pid,
		kill() {
			if (!pid) return;
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				// already gone
			}
		},
		exited,
	};
}

export function defaultDeps(home: string): PreviewDeps {
	return {
		tailscale: new Tailscale(),
		freeLocalPort,
		isListening,
		startStatic: startStaticServer,
		spawnDev,
		waitHealthy: (port, timeoutMs) => waitHealthy(port, timeoutMs),
		logDir: join(tmpdir(), "pi-preview", String(process.pid)),
		home,
	};
}
