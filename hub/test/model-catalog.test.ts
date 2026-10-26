import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
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
