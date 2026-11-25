import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runs a command and resolves with stdout; rejects on a non-zero exit with stderr in the message. */
export type Exec = (cmd: string, args: string[]) => Promise<string>;

export const defaultExec: Exec = async (cmd, args) => {
	try {
		const { stdout } = await execFileAsync(cmd, args, { timeout: 15_000 });
		return stdout;
	} catch (err) {
		const e = err as { stderr?: string; message?: string };
		const detail = (e.stderr || "").trim() || e.message || String(err);
		throw new Error(`${cmd} ${args.join(" ")} failed: ${detail}`);
	}
};

export interface ServeEntry {
	port: number;
	target: string; // like "http://127.0.0.1:5173"
}

/** The HTTPS proxy entries in a `tailscale serve status --json` output, sorted by port. */
function parseEntries(raw: string): ServeEntry[] {
	const out = raw.trim();
	if (!out) return [];
	const cfg = JSON.parse(out);
	const tcp = cfg?.TCP ?? {};
	const web = cfg?.Web ?? {};
	const result: ServeEntry[] = [];
	for (const [key, value] of Object.entries(web)) {
		const port = Number(key.slice(key.lastIndexOf(":") + 1));
		if (!Number.isInteger(port) || tcp[String(port)]?.HTTPS !== true) continue;
		const target = (value as any)?.Handlers?.["/"]?.Proxy;
		if (typeof target !== "string") continue;
		result.push({ port, target });
	}
	return result.sort((a, b) => a.port - b.port);
}

/** The synchronous twin of Exec, for teardown that must finish before the process exits. */
export type ExecSync = (cmd: string, args: string[]) => string;

export const defaultExecSync: ExecSync = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] });

export class Tailscale {
	private exec: Exec;
	private execSync: ExecSync | undefined;

	constructor(exec: Exec = defaultExec, execSync: ExecSync | undefined = exec === defaultExec ? defaultExecSync : undefined) {
		this.exec = exec;
		this.execSync = execSync;
	}

	/** True when this instance can run tailscale synchronously (removeSync, entriesSync). */
	get sync(): boolean {
		return this.execSync !== undefined;
	}

	/** entries(), synchronously; throws without a sync exec. */
	entriesSync(): ServeEntry[] {
		if (!this.execSync) throw new Error("no synchronous tailscale exec");
		return parseEntries(this.execSync("tailscale", ["serve", "status", "--json"]));
	}

	/** remove(), synchronously; throws without a sync exec. */
	removeSync(port: number): void {
		if (!this.execSync) throw new Error("no synchronous tailscale exec");
		this.execSync("tailscale", ["serve", `--https=${port}`, "off"]);
	}

	/** Self.DNSName from `tailscale status --json`, trailing dot stripped. */
	async host(): Promise<string> {
		const status = JSON.parse(await this.exec("tailscale", ["status", "--json"]));
		const name = status?.Self?.DNSName;
		if (typeof name !== "string" || !name) throw new Error("tailscale status has no Self.DNSName");
		return name.replace(/\.$/, "");
	}

	/** HTTPS proxy entries from `tailscale serve status --json`, sorted by port. */
	async entries(): Promise<ServeEntry[]> {
		return parseEntries(await this.exec("tailscale", ["serve", "status", "--json"]));
	}

	/** `tailscale serve --bg --https=<port> http://127.0.0.1:<local>` */
	async add(port: number, local: number): Promise<void> {
		await this.exec("tailscale", ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${local}`]);
	}

	/** `tailscale serve --https=<port> off` */
	async remove(port: number): Promise<void> {
		await this.exec("tailscale", ["serve", `--https=${port}`, "off"]);
	}

	/** Removes entries in [min, max] whose target port is not listening; returns the ports removed. */
	async reconcile(
		range: { min: number; max: number },
		listening: (port: number) => Promise<boolean>,
	): Promise<number[]> {
		const removed: number[] = [];
		for (const entry of await this.entries()) {
			if (entry.port < range.min || entry.port > range.max) continue;
			let local = 0;
			try {
				const url = new URL(entry.target);
				local = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
			} catch {
				// unparseable target: treat as dead
			}
			if (local && (await listening(local))) continue;
			await this.remove(entry.port);
			removed.push(entry.port);
		}
		return removed;
	}
}
