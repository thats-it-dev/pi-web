import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionTypeStore } from "../src/session-types.ts";

test("an unknown id, a missing file and a corrupt file are code", () => {
	const dir = mkdtempSync(join(tmpdir(), "types-"));
	const s = new SessionTypeStore(join(dir, "session-types.json"));
	assert.equal(s.get("nope"), "code");
	writeFileSync(join(dir, "session-types.json"), "{not json");
	assert.equal(new SessionTypeStore(join(dir, "session-types.json")).get("x"), "code");
});
test("set chat is remembered across instances; set code removes the entry", () => {
	const file = join(mkdtempSync(join(tmpdir(), "types-")), "session-types.json");
	const s = new SessionTypeStore(file);
	s.set("a", "chat");
	assert.equal(new SessionTypeStore(file).get("a"), "chat");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: "chat" });
	s.set("a", "code");
	assert.equal(new SessionTypeStore(file).get("a"), "code");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
});
