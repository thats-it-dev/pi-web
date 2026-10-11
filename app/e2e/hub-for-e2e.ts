import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeModel } from "../../hub/test/support/fake-model.ts";
import { makePiEnv } from "../../hub/test/support/pi-env.ts";

const PORT = 7898; // keep in sync with playwright.config.ts
const WORKDIR = join(tmpdir(), "pi-web-e2e-work"); // keep in sync with smoke.spec.ts

const model = await startFakeModel();
const pi = makePiEnv({ modelUrl: model.url });
rmSync(WORKDIR, { recursive: true, force: true });
mkdirSync(WORKDIR, { recursive: true });

const dataDir = join(pi.root, "hub");
mkdirSync(dataDir);
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ port: PORT, hostname: "localhost:5173", allowedLogin: "dev@local", dev: true, piBin: pi.piBin }));

Object.assign(process.env, pi.env, { PI_WEB_DATA_DIR: dataDir });
process.on("exit", () => pi.cleanup());
await import("../../hub/src/main.ts");
