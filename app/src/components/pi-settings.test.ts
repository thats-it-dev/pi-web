import { expect, test } from "vitest";
import { watchSectionCopy } from "../lib/watch-settings.ts";

test("watchSectionCopy exposes the token and secret when the hub has them, and says to update otherwise", () => {
	expect(watchSectionCopy({ ok: true, login: "x", hubVersion: "1", vapidPublicKey: null, watch: { token: "t", indexSecret: "s" } })).toEqual({ token: "t", secret: "s", hint: expect.stringContaining("Pebble") });
	expect(watchSectionCopy(null).token).toBeNull();
	expect(watchSectionCopy(null).hint).toBe("This hub predates watch support; update it.");
});
