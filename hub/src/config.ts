import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APPROVAL_MODES, type ApprovalMode } from "../../shared/src/protocol.ts";

export interface HubConfig {
	port: number;
	hostname: string; // tailnet host:port the browser uses, e.g. spark-713a.tail9274fa.ts.net:7878
	allowedLogin: string; // Tailscale-User-Login value allowed in, e.g. michaelthatsit@github
	allowedOrigins: string[];
	idleMinutes: number;
	maxHeadless: number;
	piBin: string;
	approvalMode: ApprovalMode; // the default for app-started sessions (see auto-approve.ts)
	dev: boolean;
	dataDir: string;
}

export const DEFAULTS = {
	port: 7878,
	hostname: "",
	allowedLogin: "",
	allowedOrigins: ["https://pi.thatsit.app"],
	idleMinutes: 20,
	maxHeadless: 6,
	piBin: "pi",
	approvalMode: "auto" as ApprovalMode,
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
	const cfg: HubConfig = { ...DEFAULTS, ...raw, dataDir };
	if (raw.autoApprove === false && raw.approvalMode === undefined) cfg.approvalMode = "manual"; // the setting's earlier, boolean form
	if (!APPROVAL_MODES.includes(cfg.approvalMode)) throw new ConfigError(`approvalMode in ${file} must be one of ${APPROVAL_MODES.join(", ")}`);
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
