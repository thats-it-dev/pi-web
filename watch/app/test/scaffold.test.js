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
