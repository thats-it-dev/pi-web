// The preview tool's engine: one live preview per session (a Vite dev server or a static
// folder), exposed on the tailnet through `tailscale serve` on a port in 10600-10649.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
	/** This process's folder for dev logs and pgid files: <stateDir>/<pid>. */
	logDir: string;
	/** Where every pi process keeps its <pid> folder; scanned for orphans of dead owners. Defaults to tmpdir()/pi-preview. */
	stateDir?: string;
	now?: () => number;
	/** Home folder for mockup scratch dirs; defaults to os.homedir(). */
	home?: string;
}

export const HEALTH_TIMEOUT_MS = 30_000;
export const STATUS_KEY = "preview";
const LOG_TAIL_LINES = 20;

interface Started {
	localPort: number;
	close(): Promise<void>;
	/** Synchronous teardown for session shutdown: signal the server, do not wait. */
	killNow(): void;
	onExit?: Promise<unknown>;
}

interface Active extends Started {
	details: PreviewDetails;
	dead: boolean;
}

export function defaultStateDir(): string {
	return join(tmpdir(), "pi-preview");
}

/**
 * The file a dev server's process group id is recorded in: <logDir>/pgid-<localPort>. One per
 * server (the local port is unique while it runs), so an orphan left by a pi that died can be
 * killed by the next pi that exposes a preview.
 */
export function pgidFile(logDir: string, localPort: number): string {
	return join(logDir, `pgid-${localPort}`);
}

function sameTarget(target: string, localPort: number): boolean {
	return target.replace(/\/$/, "") === `http://127.0.0.1:${localPort}`;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code !== "ESRCH";
	}
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

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
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
	/** Kills the dev server still waiting for its health check, if any. */
	private starting: (() => void) | null = null;
	/** Bumped by killNow so a start that was in flight never gets exposed. */
	private epoch = 0;

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

	/**
	 * For session shutdown: kill the dev process group (also one still in its health wait) and close
	 * the static server now, without waiting for the queue. The serve entry stays for stop() to remove.
	 */
	killNow(): void {
		this.epoch++;
		this.starting?.();
		const cur = this.active;
		if (!cur) return;
		cur.dead = true;
		try {
			cur.killNow();
		} catch {
			// already gone
		}
		// The serve entry goes with the server, synchronously: the hub's idle reaper ends pi with its stdin, and the
		// queued stop() did not get to run before the process was gone, so the entry stayed on, pointing at a dead
		// port (website 2026-11-24: the panel URL served nothing for 80 minutes).
		const ts = this.deps.tailscale;
		if (!ts.sync) return;
		try {
			const entry = ts.entriesSync().find((e) => e.port === cur.details.port);
			if (entry && sameTarget(entry.target, cur.localPort)) ts.removeSync(cur.details.port);
		} catch {
			// stop() or the next start's reconcile gets it
		}
	}

	/** `~` and `~/x` are the home folder; anything else resolves against the session cwd. */
	private abs(sessionCwd: string, path: string): string {
		const home = this.deps.home ?? homedir();
		if (path === "~") return home;
		if (path.startsWith("~/")) return join(home, path.slice(2));
		return resolve(sessionCwd, path);
	}

	private async runNow(params: PreviewParams, sessionCwd: string, sessionId: string): Promise<ToolResult> {
		try {
			if (params.stop) {
				await this.stopNow();
				return { content: text("Preview stopped."), details: { stopped: true } };
			}
			if (params.cwd !== undefined) return await this.runDev(this.abs(sessionCwd, params.cwd));
			if (params.dir !== undefined) {
				const root = this.abs(sessionCwd, params.dir);
				if (!isDir(root)) return errorResult(`${root} is not a folder.`);
				return await this.runStatic(root, basename(root), "");
			}
			if (params.file !== undefined) {
				const file = this.abs(sessionCwd, params.file);
				if (!isFile(file)) return errorResult(`${file} is not a file.`);
				const name = basename(file);
				return await this.runStatic(dirname(file), name, `/${encodeURIComponent(name)}`);
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
		return this.expose(root, basename(root), "dev", host, "", async (servePort) => {
			const localPort = await this.deps.freeLocalPort();
			const logDir = this.deps.logDir;
			mkdirSync(logDir, { recursive: true });
			const log = join(logDir, `preview-${servePort}.log`);
			const proc = this.deps.spawnDev(root, localPort, host, log);
			const kill = () => {
				proc.kill();
				rmSync(pgidFile(logDir, localPort), { force: true });
			};
			let exited = false;
			proc.exited.then(
				() => (exited = true),
				() => (exited = true),
			);
			this.starting = kill;
			let healthy;
			try {
				healthy = await Promise.race([
					this.deps.waitHealthy(localPort, HEALTH_TIMEOUT_MS),
					proc.exited.then(
						() => false,
						() => false,
					),
				]);
			} finally {
				this.starting = null;
			}
			if (!healthy) {
				kill();
				const tail = readTail(log, LOG_TAIL_LINES);
				const why = exited ? "exited before it answered" : `did not answer within ${HEALTH_TIMEOUT_MS / 1000}s`;
				throw new Error(`The dev server in ${root} ${why}.${tail ? `\nLast log lines:\n${tail}` : ""}`);
			}
			return {
				localPort,
				close: async () => kill(),
				killNow: kill,
				onExit: proc.exited,
			};
		});
	}

	private async runStatic(root: string, label: string, path: string): Promise<ToolResult> {
		const host = await this.deps.tailscale.host();
		return this.expose(root, label, "static", host, path, async () => {
			const server = await this.deps.startStatic(root);
			return { localPort: server.port, close: () => server.close(), killNow: () => void server.close() };
		});
	}

	/**
	 * Kills the dev servers of pi processes that died without stopping them: every
	 * <stateDir>/<pid> whose owner is gone has its recorded process groups sent SIGTERM and is
	 * removed. Folders of live owners (and our own) are left alone.
	 */
	private reapOrphans(): void {
		const stateDir = this.deps.stateDir ?? defaultStateDir();
		let names: string[];
		try {
			names = readdirSync(stateDir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!/^\d+$/.test(name)) continue;
			const owner = Number(name);
			if (owner === process.pid || isAlive(owner)) continue;
			const ownerDir = join(stateDir, name);
			try {
				for (const f of readdirSync(ownerDir)) {
					if (!f.startsWith("pgid-")) continue;
					const pgid = Number(readFileSync(join(ownerDir, f), "utf8").trim());
					if (!Number.isInteger(pgid) || pgid <= 1) continue;
					try {
						process.kill(-pgid, "SIGTERM");
					} catch {
						// already gone
					}
				}
				rmSync(ownerDir, { recursive: true, force: true });
			} catch {
				// unreadable: leave it
			}
		}
	}

	/**
	 * Stop any current preview, reap orphans, reconcile the range, pick a serve port, start the
	 * server, then claim the port: re-read the table before adding (another pi may have taken the
	 * port during the health wait) and confirm after adding that the entry is ours; a lost port is
	 * re-picked once. `path` is appended to the URL (the file form's file name).
	 */
	private async expose(
		root: string,
		label: string,
		kind: PreviewKind,
		host: string,
		path: string,
		start: (servePort: number) => Promise<Started>,
	): Promise<ToolResult> {
		await this.stopNow();
		this.reapOrphans();
		const ts = this.deps.tailscale;
		await ts.reconcile({ min: SERVE_PORT_MIN, max: SERVE_PORT_MAX }, this.deps.isListening);
		let port = pickServePort((await ts.entries()).map((e) => e.port));
		if (port === null) return errorResult(`No free preview port in ${SERVE_PORT_MIN}-${SERVE_PORT_MAX}.`);
		const epoch = this.epoch;
		let started: Started;
		try {
			started = await start(port);
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
		if (epoch !== this.epoch) {
			started.killNow();
			return errorResult("Preview stopped: the session is ending.");
		}
		let claimed: number | null = null;
		try {
			for (let attempt = 0; attempt < 2 && claimed === null; attempt++) {
				const table = await ts.entries();
				const holder = table.find((e) => e.port === port);
				if (port === null || (holder && !sameTarget(holder.target, started.localPort))) {
					port = pickServePort(table.map((e) => e.port));
					if (port === null) break;
				}
				await ts.add(port, started.localPort);
				const entry = (await ts.entries()).find((e) => e.port === port);
				if (entry && sameTarget(entry.target, started.localPort)) claimed = port;
				else port = null; // another session overwrote it: re-pick from a fresh read
			}
		} catch (e) {
			await started.close().catch(() => {});
			throw e;
		}
		if (claimed === null) {
			await started.close().catch(() => {});
			return errorResult(`Could not claim a preview port in ${SERVE_PORT_MIN}-${SERVE_PORT_MAX}: other sessions took them first.`);
		}
		port = claimed;
		// "Preview open" means the port answers now, whatever the server kind: a static server that failed to bind, or a
		// dev server that died between its health check and the claim, is an error, not an open preview.
		if (!(await this.deps.waitHealthy(started.localPort, 5000))) {
			await started.close().catch(() => {});
			await ts.remove(port).catch(() => {});
			return errorResult(`The preview server on 127.0.0.1:${started.localPort} is not answering, so the preview is not open. Call preview again; if it fails twice, tell Michael.`);
		}
		const details: PreviewDetails = { url: `https://${host}:${port}${path}`, label, kind, port, root };
		const active: Active = { ...started, details, dead: false };
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
			const entry = (await ts.entries()).find((e) => e.port === cur.details.port);
			if (entry && sameTarget(entry.target, cur.localPort)) await ts.remove(cur.details.port);
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

/**
 * Starts `npm run dev -- --host 127.0.0.1 --port <port> --strictPort` in its own process group and
 * records the group id in pgidFile(dirname(log), port), removed again when the process exits.
 * kill() signals the whole group, and is a no-op once the process has exited so a recycled
 * group id is never signalled.
 */
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
	const pgid = pgidFile(dirname(log), port);
	if (pid) {
		try {
			writeFileSync(pgid, String(pid));
		} catch {
			// best effort: only orphan cleanup reads it
		}
	}
	let gone = false;
	const exited = new Promise<number | null>((done) => {
		const finish = (code: number | null) => {
			gone = true;
			rmSync(pgid, { force: true });
			done(code);
		};
		child.once("error", () => finish(127));
		child.once("exit", (code) => finish(code));
	});
	return {
		pid,
		kill() {
			if (!pid || gone) return;
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
		logDir: join(defaultStateDir(), String(process.pid)),
		stateDir: defaultStateDir(),
		home,
	};
}
