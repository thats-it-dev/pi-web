import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { notificationFrame } from "../src/notification-frame.ts";

test("notificationFrame matches the frame that popped up on the watch", () => {
	const hex = readFileSync(new URL("./fixtures/notification-frame.hex", import.meta.url), "utf8").split("\n").find((l) => l && !l.startsWith("#"))!.trim();
	const f = notificationFrame({
		appUuid: "6d55f4ea-2ff6-419e-a2be-1ebdfd4f8f0b",
		itemId: "f04a5bd5-9664-47ef-bbc7-20439df0ba33",
		token: 28460,
		time: 1793122777,
		title: "pi · watch-ui",
		body: "Run npm test in pi-web/hub?",
		launchCode: 42,
	});
	assert.equal(Buffer.from(f).toString("hex"), hex);
});

test("notificationFrame rejects a bad uuid", () => {
	assert.throws(() => notificationFrame({ appUuid: "x", itemId: "y", token: 1, time: 1, title: "t", body: "b", launchCode: 1 }));
});
