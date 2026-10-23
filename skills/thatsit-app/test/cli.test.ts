import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parseArgs } from "../scripts/thatsit-app.ts";

test("parseArgs new", () => {
	const a = parseArgs(["new", "foo", "--title", "T", "--description", "D", "--resume"]);
	assert.deepEqual(a, { cmd: "new", name: "foo", title: "T", description: "D", color: "#FFAA00", resume: true });
});

test("parseArgs usage errors", () => {
	assert.equal(parseArgs([]), null);
	assert.equal(parseArgs(["check"]), null);
	assert.equal(parseArgs(["new", "foo"]), null);
	assert.equal(parseArgs(["bogus", "x"]), null);
});

test("usage error exits 2", () => {
	try {
		execFileSync("node", ["scripts/thatsit-app.ts"], { stdio: "pipe" });
		assert.fail("should exit");
	} catch (e) {
		assert.equal((e as { status: number }).status, 2);
	}
});
