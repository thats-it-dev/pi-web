import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APPROVAL_MODES, type ApprovalMode } from "../../shared/src/protocol.ts";

export interface HubConfig {
	port: number;
	internalPort: number; // loopback-only API for local services (internal-server.ts)
	hostname: string; // tailnet host:port the browser uses, e.g. spark-713a.tail9274fa.ts.net:7878
	allowedLogin: string; // Tailscale-User-Login value allowed in, e.g. michaelthatsit@github
	allowedOrigins: string[];
	idleMinutes: number;
	maxHeadless: number;
	piBin: string;
	push: boolean; // Web Push alerts for finished turns, waiting dialogs and ring questions (notifier.ts)
	approvalMode: ApprovalMode; // the default for app-started sessions (see auto-approve.ts)
	ringProfileUrl: string; // the ring-profile service ring notes are forwarded to; "" turns forwarding off
	dev: boolean;
	dataDir: string;
}

export const DEFAULTS = {
	port: 7878,
	internalPort: 7879,
	hostname: "",
	allowedLogin: "",
	allowedOrigins: ["https://pi.thatsit.app"],
	idleMinutes: 20,
	maxHeadless: 6,
	piBin: "pi",
	approvalMode: "auto" as ApprovalMode,
	push: true,
	ringProfileUrl: "http://127.0.0.1:7880",
	dev: false,
};

export const DEV_ORIGIN = "http://localhost:5173";

export class ConfigError extends Error {}

export function defaultDataDir(): string {
	return process.env.PI_WEB_DATA_DIR || join(homedir(), ".config", "pi-web");
}

export function loadConfig(dataDir = defaultDataDir()): HubConfig {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const file = join(dataDir, "config.json");
	if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`, { mode: 0o600 });
	const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	const { watchAlert, ...rest } = raw;
	const cfg: HubConfig = { ...DEFAULTS, ...rest, dataDir };
	if (watchAlert !== undefined && raw.push === undefined) cfg.push = watchAlert !== "off"; // the setting's earlier, four-mode form
	if (raw.autoApprove === false && raw.approvalMode === undefined) cfg.approvalMode = "manual"; // the setting's earlier, boolean form
	if (!APPROVAL_MODES.includes(cfg.approvalMode)) throw new ConfigError(`approvalMode in ${file} must be one of ${APPROVAL_MODES.join(", ")}`);
	if (typeof cfg.push !== "boolean") throw new ConfigError(`push in ${file} must be true or false`);
	if (!cfg.hostname || !cfg.allowedLogin) {
		throw new ConfigError(
			`Set hostname and allowedLogin in ${file}.\n` +
				`  hostname: the tailnet host:port you open in the browser (run \`tailscale status --json\`, Self.DNSName, plus :${cfg.port})\n` +
				"  allowedLogin: your Tailscale login, e.g. michaelthatsit@github",
		);
	}
	if (cfg.dev && !cfg.allowedOrigins.includes(DEV_ORIGIN)) cfg.allowedOrigins = [...cfg.allowedOrigins, DEV_ORIGIN];
	return cfg;
}
