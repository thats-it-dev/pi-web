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

test("parseArgs ship and pr", () => {
	assert.deepEqual(parseArgs(["ship", "/x/foo"]), { cmd: "ship", name: "/x/foo" });
	assert.deepEqual(parseArgs(["pr", "/x/foo", "--title", "T", "--body", "B"]), { cmd: "pr", name: "/x/foo", title: "T", body: "B" });
	assert.equal(parseArgs(["pr", "/x/foo", "--title", "T"]), null);
	assert.equal(parseArgs(["ship", "/x/foo", "--title", "T"]), null);
});

test("parseArgs gateway subcommands and pr --gateway-pr", () => {
	assert.deepEqual(parseArgs(["gateway-checkout"]), { cmd: "gateway-checkout" });
	assert.equal(parseArgs(["gateway-checkout", "x"]), null);
	assert.deepEqual(parseArgs(["gateway-register", "tips"]), { cmd: "gateway-register", name: "tips" });
	assert.equal(parseArgs(["gateway-register"]), null);
	assert.deepEqual(parseArgs(["gateway-pr", "/x/gw", "--title", "T", "--body", "B"]), { cmd: "gateway-pr", name: "/x/gw", title: "T", body: "B" });
	assert.equal(parseArgs(["gateway-pr", "/x/gw", "--title", "T"]), null);
	assert.deepEqual(parseArgs(["pr", "/x/foo", "--title", "T", "--body", "B", "--gateway-pr", "12"]), { cmd: "pr", name: "/x/foo", title: "T", body: "B", gatewayPr: 12 });
	assert.deepEqual(parseArgs(["pr", "/x/foo", "--gateway-pr", "#7", "--body", "B", "--title", "T"]), { cmd: "pr", name: "/x/foo", title: "T", body: "B", gatewayPr: 7 });
	for (const n of ["0", "500", "x", "1.5", ""]) assert.equal(parseArgs(["pr", "/x/foo", "--title", "T", "--body", "B", "--gateway-pr", n]), null, n);
});
