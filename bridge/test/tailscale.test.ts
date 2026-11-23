import assert from "node:assert/strict";
import { test } from "node:test";
import { Tailscale } from "../tailscale.ts";

const STATUS = JSON.stringify({ Self: { DNSName: "spark-713a.tail9274fa.ts.net." } });
const SERVE = JSON.stringify({
	TCP: { "9502": { HTTPS: true }, "10600": { HTTPS: true }, "10601": { HTTPS: true } },
	Web: {
		"spark-713a.tail9274fa.ts.net:9502": { Handlers: { "/": { Proxy: "http://127.0.0.1:19502" } } },
		"spark-713a.tail9274fa.ts.net:10600": { Handlers: { "/": { Proxy: "http://127.0.0.1:41000" } } },
		"spark-713a.tail9274fa.ts.net:10601": { Handlers: { "/": { Proxy: "http://127.0.0.1:41001" } } },
	},
});

function fake() {
	const calls: string[][] = [];
	const ts = new Tailscale(async (cmd, args) => {
		calls.push([cmd, ...args]);
		if (args[0] === "status") return STATUS;
		if (args[0] === "serve" && args[1] === "status") return SERVE;
		return "";
	});
	return { ts, calls };
}

test("host strips the trailing dot", async () => {
	assert.equal(await fake().ts.host(), "spark-713a.tail9274fa.ts.net");
});

test("entries lists https proxies by port", async () => {
	assert.deepEqual(await fake().ts.entries(), [
		{ port: 9502, target: "http://127.0.0.1:19502" },
		{ port: 10600, target: "http://127.0.0.1:41000" },
		{ port: 10601, target: "http://127.0.0.1:41001" },
	]);
});

test("add and remove run the serve commands", async () => {
	const { ts, calls } = fake();
	await ts.add(10602, 5173);
	await ts.remove(10602);
	assert.deepEqual(calls, [
		["tailscale", "serve", "--bg", "--https=10602", "http://127.0.0.1:5173"],
		["tailscale", "serve", "--https=10602", "off"],
	]);
});

test("reconcile removes dead entries in range only", async () => {
	const { ts, calls } = fake();
	const removed = await ts.reconcile({ min: 10600, max: 10649 }, async (port) => port === 41001);
	assert.deepEqual(removed, [10600]);
	assert.ok(calls.some((c) => c.join(" ") === "tailscale serve --https=10600 off"));
	assert.ok(!calls.some((c) => c.includes("--https=9502")));
});

function fakeServe(web: Record<string, string>) {
	const calls: string[][] = [];
	const tcp: Record<string, unknown> = {};
	const w: Record<string, unknown> = {};
	for (const [port, proxy] of Object.entries(web)) {
		tcp[port] = { HTTPS: true };
		w[`h.ts.net:${port}`] = { Handlers: { "/": { Proxy: proxy } } };
	}
	const ts = new Tailscale(async (cmd, args) => {
		calls.push([cmd, ...args]);
		return args[0] === "serve" && args[1] === "status" ? JSON.stringify({ TCP: tcp, Web: w }) : "";
	});
	return { ts, calls };
}

test("reconcile keeps a live target on a default port", async () => {
	const { ts, calls } = fakeServe({ "10600": "http://127.0.0.1" });
	const removed = await ts.reconcile({ min: 10600, max: 10649 }, async (port) => port === 80);
	assert.deepEqual(removed, []);
	assert.ok(!calls.some((c) => c.includes("off")));
});

test("reconcile removes a malformed target and keeps processing", async () => {
	const { ts, calls } = fakeServe({ "10600": "not a url", "10601": "http://127.0.0.1:41001", "10602": "http://127.0.0.1:41002" });
	const removed = await ts.reconcile({ min: 10600, max: 10649 }, async (port) => port === 41001);
	assert.deepEqual(removed, [10600, 10602]);
	assert.ok(calls.some((c) => c.join(" ") === "tailscale serve --https=10600 off"));
	assert.ok(calls.some((c) => c.join(" ") === "tailscale serve --https=10602 off"));
});
