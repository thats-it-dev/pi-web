import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bearerMatches, loadWatchSecrets } from "../src/watch-secrets.ts";

test("creates watch.json with two 32-byte hex secrets, mode 0600, and reloads the same values", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-watch-secrets-"));
	const a = loadWatchSecrets(dir);
	assert.match(a.token, /^[0-9a-f]{64}$/);
	assert.match(a.indexSecret, /^[0-9a-f]{64}$/);
	assert.notEqual(a.token, a.indexSecret);
	assert.equal(statSync(join(dir, "watch.json")).mode & 0o777, 0o600);
	assert.deepEqual(loadWatchSecrets(dir), a);
});

test("an unreadable watch.json is replaced and logged", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-watch-secrets-"));
	writeFileSync(join(dir, "watch.json"), "not json");
	const lines: string[] = [];
	const s = loadWatchSecrets(dir, (m) => lines.push(m));
	assert.match(s.token, /^[0-9a-f]{64}$/);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /watch\.json/);
	assert.deepEqual(loadWatchSecrets(dir), s);
});

test("bearerMatches accepts only the exact token", () => {
	assert.equal(bearerMatches("Bearer abc", "abc"), true);
	assert.equal(bearerMatches("bearer abc", "abc"), true);
	assert.equal(bearerMatches("Bearer abd", "abc"), false);
	assert.equal(bearerMatches("Bearer ab", "abc"), false);
	assert.equal(bearerMatches(undefined, "abc"), false);
	assert.equal(bearerMatches("abc", "abc"), false);
});
