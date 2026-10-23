import { test } from "node:test";
import assert from "node:assert/strict";
import { checkName } from "../scripts/lib/names.ts";
import { fakeRun } from "./helpers.ts";

const free = {
	"gh repo view": { code: 1, stderr: "Could not resolve to a Repository" },
	"cf pages get": { code: 1, stderr: "[8000007] Project not found." },
	"cf dns records list": { stdout: "[]" },
};

test("free name is ok", async () => {
	assert.deepEqual(await checkName("foo", fakeRun(free).run), { ok: true });
});

test("invalid names", async () => {
	for (const n of ["Foo", "1a", "a_b", "-a", "a-", "", "a".repeat(31)]) {
		const r = await checkName(n, fakeRun(free).run);
		assert.equal(r.ok, false, n);
		assert.match(r.ok ? "" : r.reason, /invalid name/);
	}
});

test("reserved names", async () => {
	for (const n of ["pi", "kit", "www", "app", "api", "mail", "app-template"]) {
		const r = await checkName(n, fakeRun(free).run);
		assert.equal(r.ok, false, n);
		assert.match(r.ok ? "" : r.reason, /reserved/);
	}
});

test("GitHub repo exists", async () => {
	const f = fakeRun({ ...free, "gh repo view": { stdout: '{"name":"foo"}' } });
	const r = await checkName("foo", f.run);
	assert.equal(r.ok, false);
	assert.match(r.ok ? "" : r.reason, /GitHub repo exists/);
	assert.deepEqual(f.calls[0].args, ["repo", "view", "thats-it-dev/foo", "--json", "name"]);
});

test("Pages project exists", async () => {
	const f = fakeRun({ ...free, "cf pages get": { stdout: JSON.stringify({ name: "foo", subdomain: "foo.pages.dev" }) } });
	const r = await checkName("foo", f.run);
	assert.match(r.ok ? "" : r.reason, /Pages project exists/);
});

test("DNS record exists", async () => {
	const f = fakeRun({ ...free, "cf dns records list": { stdout: '[{"name":"foo.thatsit.app","type":"CNAME","content":"x"}]' } });
	const r = await checkName("foo", f.run);
	assert.match(r.ok ? "" : r.reason, /DNS record exists/);
	assert.ok(f.lines().includes("cf dns records list -z thatsit.app --name foo.thatsit.app"));
});

test("a failing lookup is an error, not 'free'", async () => {
	const f = fakeRun({ ...free, "cf pages get": { code: 1, stderr: "auth expired" } });
	await assert.rejects(checkName("foo", f.run), /auth expired/);
});
