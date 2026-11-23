import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { SERVE_PORT_MAX, SERVE_PORT_MIN, freeLocalPort, isListening, pickServePort } from "../ports.ts";

test("the range is 10600-10649 and pickServePort takes the lowest free one", () => {
	assert.deepEqual([SERVE_PORT_MIN, SERVE_PORT_MAX], [10600, 10649]);
	assert.equal(pickServePort([]), 10600);
	assert.equal(pickServePort([10600, 10601, 9502]), 10602);
	const all = Array.from({ length: 50 }, (_, i) => 10600 + i);
	assert.equal(pickServePort(all), null);
});

test("freeLocalPort returns a port nothing listens on; isListening sees a server", async () => {
	const port = await freeLocalPort();
	assert.ok(port > 0);
	assert.equal(await isListening(port), false);
	const srv = createServer().listen(port, "127.0.0.1");
	await new Promise((r) => srv.once("listening", r));
	assert.equal(await isListening(port), true);
	srv.close();
});
