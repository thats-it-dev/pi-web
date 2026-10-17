const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const pkg = require(path.join(__dirname, "..", "package.json"));

test("uuid is a v4 uuid", () => {
  assert.match(pkg.pebble.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("targets emery and gabbro", () => {
  assert.deepEqual(pkg.pebble.targetPlatforms, ["emery", "gabbro"]);
});

test("main.js KEYS match messageKeys in order (pebble/message maps index n to 10000 + n)", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "embeddedjs", "main.js"), "utf8");
  const block = src.match(/export const KEYS = \[([\s\S]*?)\];/);
  assert.ok(block, "KEYS array in main.js");
  const keys = [...block[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, pkg.pebble.messageKeys);
});
