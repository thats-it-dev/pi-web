import { expect, test } from "vitest";
import { ICONS } from "./icons.ts";

test.each(["code", "message-circle", "square-pen"])("ICONS has %s as an svg", (name) => {
	expect(Object.keys(ICONS)).toContain(name);
	const src = (ICONS as Record<string, { strings: readonly string[] }>)[name].strings.join("");
	expect(src).toContain("<svg");
	expect(src).toContain('viewBox="0 0 24 24"');
});
