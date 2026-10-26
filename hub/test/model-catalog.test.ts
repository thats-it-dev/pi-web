import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Catalog, ModelCatalog, resolveChoice } from "../src/model-catalog.ts";
import { type FakeModel, startFakeModel } from "./support/fake-model.ts";
import { makePiEnv } from "./support/pi-env.ts";

let model: FakeModel;
before(async () => {
	model = await startFakeModel();
});
after(() => model.close());

const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : []);

test("probes models and pi's default without writing a session file", async (t) => {
	const env = makePiEnv({ modelUrl: model.url });
	t.after(() => env.cleanup());
	const cat = await new ModelCatalog({ piBin: env.piBin, env: env.env }).get();
	assert.equal(cat.models.length, 2);
	assert.equal(cat.piDefault?.provider, "fake");
	assert.equal(cat.piDefault?.modelId, "fake-a");
	assert.ok(cat.levels["fake/fake-a"]?.includes("high"), "a reasoning model's levels are probed");
	assert.deepEqual(files(join(env.agentDir, "sessions")), []);
});

test("concurrent calls share one probe, and the result is cached", async (t) => {
	const env = makePiEnv({ modelUrl: model.url });
	t.after(() => env.cleanup());
	const catalog = new ModelCatalog({ piBin: env.piBin, env: env.env });
	const [a, b] = await Promise.all([catalog.get(), catalog.get()]);
	assert.equal(a, b);
	assert.equal(await catalog.get(), a);
});

test("an expired catalog is answered at once while one refresh runs behind it", async (t) => {
	const env = makePiEnv({ modelUrl: model.url });
	t.after(() => env.cleanup());
	const catalog = new ModelCatalog({ piBin: env.piBin, env: env.env, ttlMs: 0 });
	const first = await catalog.get();
	const started = Date.now();
	assert.equal(await catalog.get(), first, "the stale catalog, not a fresh probe");
	assert.ok(Date.now() - started < 500, "without waiting for pi");
	let next = first;
	while (next === first) {
		await sleep(50);
		next = await catalog.get();
	}
	assert.notEqual(next, first, "a later call sees the refreshed catalog");
	assert.deepEqual(next, first);
});

test("a failed refresh keeps the stale catalog", async (t) => {
	const env = makePiEnv({ modelUrl: model.url });
	t.after(() => env.cleanup());
	// A pi that works once, then fails to start.
	const flag = join(env.root, "broken");
	const piBin = join(env.root, "pi-once");
	writeFileSync(piBin, `#!/bin/sh\nif [ -e ${JSON.stringify(flag)} ]; then exit 1; fi\ntouch ${JSON.stringify(flag)}\nexec ${JSON.stringify(env.piBin)} "$@"\n`);
	chmodSync(piBin, 0o755);
	const catalog = new ModelCatalog({ piBin, env: env.env, ttlMs: 0 });
	const first = await catalog.get();
	assert.equal(first.models.length, 2);
	assert.equal(await catalog.get(), first); // starts the refresh that fails
	await sleep(500);
	assert.equal(await catalog.get(), first);
});

test("the probe stops pi with SIGTERM, so its extensions can clean up", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-probe-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const marker = join(dir, "sigterm");
	const pidFile = join(dir, "pid");
	const env = makePiEnv({
		modelUrl: model.url,
		extensions: {
			"sigterm.ts": `import { writeFileSync } from "node:fs";\nexport default () => {\n\twriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n\tprocess.on("SIGTERM", () => writeFileSync(${JSON.stringify(marker)}, "1")); // and stays up: the grace runs out\n};\n`,
		},
	});
	t.after(() => env.cleanup());
	await new ModelCatalog({ piBin: env.piBin, env: env.env, killGraceMs: 200 }).get();
	const pid = Number(readFileSync(pidFile, "utf8"));
	const alive = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	for (let i = 0; i < 40 && alive(); i++) await sleep(50);
	assert.equal(alive(), false, "pi is gone once the grace runs out");
	assert.ok(existsSync(marker), "pi was sent SIGTERM first");
});

test("a bad piBin resolves an empty catalog", async () => {
	const cat = await new ModelCatalog({ piBin: "/nonexistent/pi" }).get();
	assert.deepEqual(cat, { models: [], piDefault: null, levels: {} });
});

test("resolveChoice falls back to pi's default for an unknown model, and drops thinking a model can't do", () => {
	const m = (id: string, reasoning: boolean) => ({ id, name: id, provider: "p", reasoning, input: ["text"], contextWindow: 1, maxTokens: 1 });
	const cat: Catalog = {
		models: [m("think", true), m("plain", false)],
		piDefault: { provider: "p", modelId: "think", thinking: "medium" },
		levels: { "p/think": ["off", "low", "high"] },
	};
	assert.deepEqual(resolveChoice(cat, { provider: "p", modelId: "think", thinking: "high" }), { provider: "p", modelId: "think", thinking: "high" });
	assert.deepEqual(resolveChoice(cat, { provider: "p", modelId: "think", thinking: "max" }), { provider: "p", modelId: "think", thinking: null });
	assert.deepEqual(resolveChoice(cat, { provider: "p", modelId: "plain", thinking: "high" }), { provider: "p", modelId: "plain", thinking: null });
	assert.deepEqual(resolveChoice(cat, { provider: "p", modelId: "gone", thinking: "high" }), cat.piDefault);
	assert.deepEqual(resolveChoice(cat, null), cat.piDefault);
});
