// Starts the hub: config → session index → registry → HTTP server.

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridgeServer } from "./bridge-server.ts";
import { ConfigError, type HubConfig, loadConfig } from "./config.ts";
import { PushStore } from "./push.ts";
import { Viewers, watchPush } from "./push-watch.ts";
import { Registry } from "./registry.ts";
import { RpcHandle } from "./rpc-handle.ts";
import { createHubServer } from "./server.ts";
import { gitUpdater } from "./update.ts";
import { WatchService } from "./watch.ts";
import { loadWatchSecrets } from "./watch-secrets.ts";
import { SessionIndex, sessionsDir } from "./sessions.ts";

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

let cfg: HubConfig;
try {
	cfg = loadConfig();
} catch (err) {
	if (err instanceof ConfigError) {
		console.error(err.message);
		process.exit(1);
	}
	throw err;
}

const exportDir = join(cfg.dataDir, "exports");
mkdirSync(exportDir, { recursive: true });
mkdirSync(join(cfg.dataDir, "index"), { recursive: true }); // webhook drop folder
const index = new SessionIndex(sessionsDir());
const registry = new Registry({
	factory: { startRpc: (o) => RpcHandle.start({ ...o, piBin: cfg.piBin, exportDir, approvalMode: cfg.approvalMode }) },
	lookup: index,
	maxHeadless: cfg.maxHeadless,
	idleMs: cfg.idleMinutes * 60_000,
});
setInterval(() => registry.reap(), 60_000).unref();
const push = new PushStore({ dataDir: cfg.dataDir, subject: cfg.allowedOrigins[0] ?? "https://pi.thatsit.app" });
const viewers = new Viewers();
watchPush(registry, (p) => void push.send(p), viewers);
const secrets = loadWatchSecrets(cfg.dataDir, (m) => console.log(m));
const watch = new WatchService({ registry, index, viewers, home: homedir() });
let bridge: Awaited<ReturnType<typeof startBridgeServer>>;
try {
	bridge = await startBridgeServer({ socketPath: join(cfg.dataDir, "bridge.sock"), registry, log: (m) => console.log(m) });
} catch (err) {
	console.error((err as Error).message);
	process.exit(1);
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const updater = gitUpdater(repoRoot, version);
const server = createHubServer({ cfg, registry, index, version, push, viewers, updater, watch, secrets });
server.listen(cfg.port, "127.0.0.1", () => {
	console.log(`pi-web hub ${version} on http://127.0.0.1:${cfg.port} (serving https://${cfg.hostname}, sessions in ${index.dir}, terminals on ${join(cfg.dataDir, "bridge.sock")})`);
});

const shutdown = () => {
	watch.close();
	registry.closeAll();
	void bridge.close();
	server.close();
	setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
