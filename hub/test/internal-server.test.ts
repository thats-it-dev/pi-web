import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { createInternalServer } from "../src/internal-server.ts";
import { QueryStore } from "../src/queries.ts";

const closers: Array<() => void> = [];
afterEach(() => {
	while (closers.length) closers.pop()?.();
});

async function listen(server: http.Server): Promise<number> {
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => server.close());
	return (server.address() as AddressInfo).port;
}

function setup(opts: { fetchFn?: typeof fetch } = {}) {
	const logs: string[] = [];
	const store = new QueryStore({ onChange: () => {} });
	closers.push(() => store.close());
	const server = createInternalServer({ store, log: (m) => logs.push(m), ...opts });
	return { store, server, logs, port: listen(server) };
}

const post = (port: number, path: string, body: unknown) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const valid = { label: "Ring", text: "Send it?", options: ["Yes", "No"], callbackUrl: "http://127.0.0.1:1/cb" };

describe("internal server", () => {
	it("raise via POST /queries returns 201 with id and the query appears in GET /queries", async () => {
		const s = setup();
		const port = await s.port;
		const res = await post(port, "/queries", valid);
		assert.equal(res.status, 201);
		const { id } = (await res.json()) as { id: string };
		assert.match(id, /^rp:/);
		const list = (await (await fetch(`http://127.0.0.1:${port}/queries`)).json()) as { queries: Array<{ id: string; text: string }> };
		assert.deepEqual(list.queries.map((q) => [q.id, q.text]), [[id, "Send it?"]]);
	});

	it("outcome is POSTed to callbackUrl once", async () => {
		const got: unknown[] = [];
		const cb = http.createServer((req, res) => {
			let b = "";
			req.on("data", (c) => (b += c));
			req.on("end", () => {
				got.push(JSON.parse(b));
				res.end("ok");
			});
		});
		const cbPort = await listen(cb);
		const s = setup();
		const port = await s.port;
		const { id } = (await (await post(port, "/queries", { ...valid, callbackUrl: `http://127.0.0.1:${cbPort}/x` })).json()) as { id: string };
		const res = await post(port, `/queries/${id}/clear-by-ring`, { text: "done" });
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true });
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(got, [{ id, outcome: { kind: "cleared-by-ring", text: "done" } }]);
		assert.equal((await post(port, `/queries/${id}/clear-by-ring`, { text: "again" })).status, 404);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(got.length, 1);
	});

	it("validation", async () => {
		const s = setup();
		const port = await s.port;
		const bad = async (patch: Record<string, unknown>) => (await post(port, "/queries", { ...valid, ...patch })).status;
		assert.equal(await bad({ text: undefined }), 400);
		assert.equal(await bad({ options: "Yes" }), 400);
		assert.equal(await bad({ options: [1] }), 400);
		assert.equal(await bad({ timeoutMs: 3_600_001 }), 400);
		assert.equal(await bad({ callbackUrl: "ftp://x/y" }), 400);
		assert.equal(await bad({ callbackUrl: "nonsense" }), 400);
		assert.equal(await bad({}), 201);
		assert.equal((await post(port, "/queries/rp:9/clear-by-ring", {})).status, 400);
	});

	it("clear-by-ring on an unknown id returns 404", async () => {
		const s = setup();
		const port = await s.port;
		assert.equal((await post(port, "/queries/rp:99/clear-by-ring", { text: "x" })).status, 404);
	});

	it("callback failure is logged and not retried", async () => {
		let calls = 0;
		const fetchFn = (async () => {
			calls++;
			throw new Error("boom");
		}) as unknown as typeof fetch;
		const s = setup({ fetchFn });
		const port = await s.port;
		const { id } = (await (await post(port, "/queries", valid)).json()) as { id: string };
		assert.equal((await post(port, `/queries/${id}/clear-by-ring`, { text: "x" })).status, 200);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(calls, 1);
		assert.ok(s.logs.some((l) => l.includes("boom")));
	});

	it("binds 127.0.0.1 only", async () => {
		const s = setup();
		await s.port;
		assert.equal((s.server.address() as AddressInfo).address, "127.0.0.1");
	});
});
