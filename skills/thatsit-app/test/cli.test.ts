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
	// --force true asks for a force-with-lease push; off or absent leaves the args as before; anything else is a typo.
	for (const v of ["true", "1", "yes"]) assert.deepEqual(parseArgs(["pr", "/x/foo", "--title", "T", "--body", "B", "--force", v]), { cmd: "pr", name: "/x/foo", title: "T", body: "B", force: true }, v);
	for (const v of ["false", "0", "no"]) assert.deepEqual(parseArgs(["pr", "/x/foo", "--title", "T", "--body", "B", "--force", v]), { cmd: "pr", name: "/x/foo", title: "T", body: "B" }, v);
	assert.equal(parseArgs(["pr", "/x/foo", "--title", "T", "--body", "B", "--force", "maybe"]), null);
	assert.equal(parseArgs(["pr", "/x/foo", "--title", "T", "--body", "B", "--force"]), null, "the flag takes a value");
	assert.deepEqual(parseArgs(["pr", "/x/foo", "--title", "T", "--body", "B", "--gateway-pr", "3", "--force", "true"]), { cmd: "pr", name: "/x/foo", title: "T", body: "B", gatewayPr: 3, force: true });
	assert.equal(parseArgs(["gateway-pr", "/x/gw", "--title", "T", "--body", "B", "--force", "true"]), null, "gateway-pr has no --force");
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

test("parseArgs pr-wait and gateway-pr-wait", () => {
	assert.deepEqual(parseArgs(["pr-wait", "/x/foo"]), { cmd: "pr-wait", name: "/x/foo" });
	assert.deepEqual(parseArgs(["gateway-pr-wait", "/x/gw"]), { cmd: "gateway-pr-wait", name: "/x/gw" });
	assert.equal(parseArgs(["pr-wait"]), null);
	assert.equal(parseArgs(["gateway-pr-wait"]), null);
	assert.equal(parseArgs(["pr-wait", "/x/foo", "--title", "T"]), null);
});

test("parseArgs screenshot", () => {
	assert.deepEqual(parseArgs(["screenshot", "/x/foo"]), { cmd: "screenshot", name: "/x/foo" });
	assert.deepEqual(parseArgs(["screenshot", "/x/foo", "--path", "/settings", "--scheme", "light"]), { cmd: "screenshot", name: "/x/foo", path: "/settings", scheme: "light" });
	assert.equal(parseArgs(["screenshot", "/x/foo", "--scheme", "sepia"]), null);
	assert.equal(parseArgs(["screenshot", "/x/foo", "--path"]), null);
	assert.equal(parseArgs(["screenshot"]), null);
});

test("parseArgs screenshot takes --path, --scheme and --click", () => {
	assert.deepEqual(parseArgs(["screenshot", "fret"]), { cmd: "screenshot", name: "fret" });
	assert.deepEqual(parseArgs(["screenshot", "fret", "--click", 'button[aria-label="Settings"]', "--scheme", "light"]), { cmd: "screenshot", name: "fret", scheme: "light", click: 'button[aria-label="Settings"]' });
	assert.equal(parseArgs(["screenshot", "fret", "--click"]), null);
	assert.equal(parseArgs(["screenshot", "fret", "--open", "x"]), null);
	assert.deepEqual(parseArgs(["screenshot", "fret", "--upload", "~/k.json"]), { cmd: "screenshot", name: "fret", upload: "~/k.json" });
	assert.deepEqual(parseArgs(["screenshot", "fret", "--click", "button", "--upload", "~/k.json", "--into", "dialog input[type=file]"]), { cmd: "screenshot", name: "fret", click: "button", upload: "~/k.json", into: "dialog input[type=file]" });
	assert.equal(parseArgs(["screenshot", "fret", "--into", "input"]), null, "--into needs --upload");
});
