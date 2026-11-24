import { expect, test } from "vitest";
import { ICONS } from "./icons.ts";

// ICONS[name] is the wrapper html template; its first value is the inner svg template carrying the path markup.
const PATHS: Record<string, string> = {
	"code": "m16 18 6-6-6-6",
	"message-circle": "M7.9 20A9",
	"square-pen": "M18.375 2.625",
};

test.each(Object.entries(PATHS))("ICONS has %s with its path data", (name, path) => {
	expect(Object.keys(ICONS)).toContain(name);
	const icon = ICONS[name as keyof typeof ICONS];
	expect(icon.strings.join("")).toContain('viewBox="0 0 24 24"');
	const inner = icon.values[0] as { strings: readonly string[] };
	expect(inner.strings.join("")).toContain(path);
});
