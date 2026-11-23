import { execFile } from "node:child_process";
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

export class Tailscale {
	private exec: Exec;

	constructor(exec: Exec = defaultExec) {
		this.exec = exec;
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
		const out = (await this.exec("tailscale", ["serve", "status", "--json"])).trim();
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
			const local = Number(new URL(entry.target).port);
			if (local && (await listening(local))) continue;
			await this.remove(entry.port);
			removed.push(entry.port);
		}
		return removed;
	}
}
