// Starts the hub: config → session index → registry → HTTP server.

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridgeServer } from "./bridge-server.ts";
import { ConfigError, type HubConfig, loadConfig } from "./config.ts";
import { createInternalServer } from "./internal-server.ts";
import { LastModelStore } from "./last-model.ts";
import { ModelCatalog } from "./model-catalog.ts";
import { PushStore } from "./push.ts";
import { Viewers, watchPush } from "./push-watch.ts";
import { Registry } from "./registry.ts";
import { RpcHandle } from "./rpc-handle.ts";
import { createHubServer } from "./server.ts";
import { gitUpdater } from "./update.ts";
import { attachWatchStream } from "./watch-stream.ts";
import { WatchService } from "./watch.ts";
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
const lastModel = new LastModelStore(join(cfg.dataDir, "last-model.json"));
const catalog = new ModelCatalog({ piBin: cfg.piBin });
const registry = new Registry({
	factory: { startRpc: (o) => RpcHandle.start({ ...o, piBin: cfg.piBin, exportDir, approvalMode: cfg.approvalMode, onModelPicked: (c) => lastModel.set(c) }) },
	lookup: index,
	maxHeadless: cfg.maxHeadless,
	idleMs: cfg.idleMinutes * 60_000,
});
setInterval(() => registry.reap(), 60_000).unref();
const push = new PushStore({ dataDir: cfg.dataDir, subject: cfg.allowedOrigins[0] ?? "https://pi.thatsit.app" });
const viewers = new Viewers();
watchPush(registry, (p) => void push.send(p), viewers);
const watch = new WatchService({ registry, index, viewers, home: homedir(), catalog, lastModel });
let bridge: Awaited<ReturnType<typeof startBridgeServer>>;
try {
	bridge = await startBridgeServer({ socketPath: join(cfg.dataDir, "bridge.sock"), registry, log: (m) => console.log(m) });
} catch (err) {
	console.error((err as Error).message);
	process.exit(1);
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const updater = gitUpdater(repoRoot, version);
const server = createHubServer({ cfg, registry, index, version, push, viewers, updater, watch, catalog, lastModel });
const stream = attachWatchStream(server, { cfg, watch, log: (m) => console.log(m) });
server.listen(cfg.port, "127.0.0.1", () => {
	console.log(`pi-web hub ${version} on http://127.0.0.1:${cfg.port} (serving https://${cfg.hostname}, sessions in ${index.dir}, terminals on ${join(cfg.dataDir, "bridge.sock")})`);
});

const internal = createInternalServer({ store: watch.queries, log: (m) => console.log(m) });
internal.listen(cfg.internalPort, "127.0.0.1", () => console.log(`internal API on http://127.0.0.1:${cfg.internalPort}`));

const shutdown = () => {
	internal.close();
	stream.close();
	watch.close();
	registry.closeAll();
	void bridge.close();
	server.close();
	setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
