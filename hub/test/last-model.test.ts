import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LastModelStore } from "../src/last-model.ts";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "pi-web-last-model-")), "last-model.json");

test("set then get round-trips, and a new store on the same file reads it back", () => {
	const f = tmpFile();
	const store = new LastModelStore(f);
	assert.equal(store.get(), null);
	store.set({ provider: "fake", modelId: "b", thinking: "high" });
	assert.deepEqual(store.get(), { provider: "fake", modelId: "b", thinking: "high" });
	assert.deepEqual(new LastModelStore(f).get(), { provider: "fake", modelId: "b", thinking: "high" });
	assert.equal(statSync(f).mode & 0o777, 0o600);
});

test("missing or corrupt file reads as null", () => {
	const f = tmpFile();
	assert.equal(new LastModelStore(f).get(), null);
	writeFileSync(f, "{nope");
	assert.equal(new LastModelStore(f).get(), null);
	writeFileSync(f, JSON.stringify({ provider: 1 }));
	assert.equal(new LastModelStore(f).get(), null);
});
