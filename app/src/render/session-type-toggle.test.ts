import { nothing } from "lit";
import { describe, expect, it, vi } from "vitest";
import { sessionTypeToggle } from "./session-type-toggle.ts";

// vitest runs in node (no DOM): flatten the lit template to markup.
function flatten(v: unknown, fns: Array<() => void>): string {
	if (v === nothing || v == null || v === false) return "";
	if (Array.isArray(v)) return v.map((x) => flatten(x, fns)).join("");
	if (typeof v === "function") return `fn:${fns.push(v as () => void) - 1}`;
	if (typeof v === "object" && "strings" in (v as object)) {
		const t = v as { strings: string[]; values: unknown[] };
		return t.strings.map((str, i) => str + (i < t.values.length ? flatten(t.values[i], fns) : "")).join("");
	}
	return String(v);
}
function mount(type: "code" | "chat", onPick = vi.fn()) {
	const fns: Array<() => void> = [];
	const html = flatten(sessionTypeToggle(type, onPick), fns);
	return { html, fns, onPick };
}
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);

describe("sessionTypeToggle", () => {
	it("marks code pressed", () => {
		const { html } = mount("code");
		expect(html).toMatch(/class="type-toggle code"/);
		expect(html).toContain('role="radiogroup"');
		const [a, b] = buttons(html);
		expect(a).toContain('aria-label="Code sessions"');
		expect(a).toContain('aria-pressed="true"');
		expect(b).toContain('aria-pressed="false"');
	});
	it("marks chat pressed", () => {
		const { html } = mount("chat");
		expect(html).toMatch(/class="type-toggle chat"/);
		const [a, b] = buttons(html);
		expect(a).toContain('aria-pressed="false"');
		expect(b).toContain('aria-label="Chat sessions"');
		expect(b).toContain('aria-pressed="true"');
	});
	it("picks the clicked type", () => {
		const { html, fns, onPick } = mount("code");
		const m = /aria-label="Chat sessions"[^>]*@click=fn:(\d+)/.exec(html);
		fns[Number(m![1])]();
		expect(onPick).toHaveBeenCalledWith("chat");
	});
	it("has two buttons with icons", () => {
		const { html } = mount("code");
		expect(buttons(html)).toHaveLength(2);
		expect(html.match(/viewBox/g)?.length ?? 0).toBe(2);
	});
});
