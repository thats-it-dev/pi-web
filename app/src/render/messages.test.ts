import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../shared/src/protocol.ts";
import { createConversation } from "../../../shared/src/reducer.ts";

// Count every real markdown parse by wrapping marked's parser.
const parses = vi.hoisted(() => ({ n: 0 }));
vi.mock("marked", async (importOriginal) => {
	const real = await importOriginal<typeof import("marked")>();
	class CountingMarked extends real.Marked {
		// forwards whatever marked takes
		constructor(...args: any[]) {
			super(...args);
			const parse = this.parse.bind(this);
			this.parse = ((src: string, opts?: object) => {
				parses.n++;
				return parse(src, opts);
			}) as typeof this.parse;
		}
	}
	return { ...real, Marked: CountingMarked };
});

const { renderConversation } = await import("./messages.ts");
const { renderMarkdown } = await import("../lib/markdown.ts");

function longConversation(turns: number): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (let i = 0; i < turns; i++) {
		out.push({ role: "user", content: `question ${i}`, timestamp: i });
		out.push({
			role: "assistant",
			content: [
				{ type: "text", text: `answer **${i}**` },
				{ type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: `echo ${i}` } },
			],
			timestamp: i,
		});
		out.push({ role: "toolResult", toolCallId: `t${i}`, content: [{ type: "text", text: `${i}` }], timestamp: i });
	}
	return out;
}

describe("renderConversation", () => {
	beforeEach(() => {
		parses.n = 0;
	});

	it("does not re-parse markdown for completed messages, even past the text cache size", () => {
		const conv = createConversation(longConversation(600));
		renderConversation(conv);
		expect(parses.n).toBe(600);
		// A streaming delta re-renders everything; only the partial is parsed again.
		conv.partial = { role: "assistant", content: [{ type: "text", text: "stre" }] };
		renderConversation(conv);
		(conv.partial.content as Array<{ text: string }>)[0].text += "aming";
		renderConversation(conv);
		expect(parses.n).toBe(602);
	});

	it("tolerates text and thinking blocks with missing fields", () => {
		const conv = createConversation([{ role: "assistant", content: [{ type: "text" }, { type: "thinking" }] as never, timestamp: 1 }]);
		expect(() => renderConversation(conv)).not.toThrow();
	});
});

describe("renderMarkdown cache", () => {
	it("is least-recently-used: a hit keeps an entry alive", () => {
		renderMarkdown("keep me");
		for (let i = 0; i < 499; i++) renderMarkdown(`filler ${i}`);
		renderMarkdown("keep me"); // refresh
		renderMarkdown("one more"); // evicts the oldest filler, not "keep me"
		parses.n = 0;
		renderMarkdown("keep me");
		expect(parses.n).toBe(0);
		renderMarkdown("filler 0");
		expect(parses.n).toBe(1);
	});
});

// Flatten a lit TemplateResult to text, spelling out bound values, so tests can
// assert on what the template contains without a DOM.
function flat(v: unknown): string {
	if (v == null || v === false) return "";
	if (Array.isArray(v)) return v.map(flat).join("");
	if (typeof v === "object" && v !== null && "strings" in v && "values" in v) {
		const t = v as { strings: readonly string[]; values: unknown[] };
		return t.strings.map((s, i) => s + (i < t.values.length ? flat(t.values[i]) : "")).join("");
	}
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

const REF = { type: "image", mimeType: "image/png", ref: "r1", width: 4, height: 3 } as const;
const showCall = (args: Record<string, unknown>) => ({ type: "toolCall", id: "c1", name: "show_image", arguments: args });
function convWith(calls: unknown[], result?: Record<string, unknown>, extra: AgentMessage[] = []) {
	const msgs: AgentMessage[] = [...extra, { role: "assistant", content: calls as never, timestamp: 1 }];
	if (result) msgs.push({ role: "toolResult", toolCallId: "c1", timestamp: 2, ...result } as AgentMessage);
	return createConversation(msgs);
}

describe("images in the conversation", () => {
	it("a show_image result renders as a figure, not a collapsed card", () => {
		const out = flat(
			renderConversation(
				convWith([showCall({ path: "shot.png", caption: "The login page" })], {
					content: [{ type: "text", text: "Displayed in the conversation: shot.png" }, REF],
					details: { path: "/w/shot.png" },
				}),
			),
		);
		expect(out).toContain("<pi-image");
		expect(out).toContain(".variant=figure");
		expect(out).toContain('"ref":"r1"');
		expect(out).toContain("The login page");
		expect(out).toContain("show_image · shot.png");
		expect(out).not.toContain('<details class="tool');
	});

	it("a show_image with see:false takes the image from details.image", () => {
		const out = flat(
			renderConversation(
				convWith([showCall({ path: "a.png", see: false })], {
					content: [{ type: "text", text: "Displayed in the conversation: a.png" }],
					details: { path: "/w/a.png", image: REF },
				}),
			),
		);
		expect(out).toContain(".variant=figure");
		expect(out).toContain('"ref":"r1"');
		expect(out).not.toContain('<details class="tool');
	});

	it("a running show_image shows the spinner; a failed one the normal error card", () => {
		const running = createConversation([{ role: "assistant", content: [showCall({ path: "a.png" })] as never, timestamp: 1 }]);
		running.tools.c1 = { running: true, isError: false } as never;
		const r = flat(renderConversation(running));
		expect(r).toContain('<span class="spin">');
		expect(r).not.toContain("<pi-image");

		const failed = flat(renderConversation(convWith([showCall({ path: "a.png" })], { isError: true, content: [{ type: "text", text: "not an image" }] })));
		expect(failed).toContain('<details class="tool error"');
		expect(failed).toContain("not an image");
		expect(failed).not.toContain("<pi-image");
	});

	it("other tools' images render as thumbnails under the text output", () => {
		const out = flat(
			renderConversation(
				convWith([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x.png" } }], {
					content: [{ type: "text", text: "Read image file" }, REF],
				}),
			),
		);
		expect(out).toContain('<pre class="out">Read image file</pre>');
		expect(out).toContain(".variant=thumb");
		expect(out.indexOf('<pre class="out">')).toBeLessThan(out.indexOf("<pi-image"));
		expect(out).toContain('<details class="tool ok"');
	});

	it("user images render through pi-image", () => {
		const out = flat(renderConversation(createConversation([{ role: "user", content: [{ type: "text", text: "look" }, REF], timestamp: 1 }] as never)));
		expect(out).toContain("<pi-image");
		expect(out).toContain(".variant=thumb");
		expect(out).not.toContain("<img");
	});

	it("inline data images still render", () => {
		const out = flat(renderConversation(createConversation([{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }], timestamp: 1 }] as never)));
		expect(out).toContain("<pi-image");
		expect(out).toContain('"data":"AAAA"');
		expect(out).not.toContain('"ref"');
	});

	it("passes the loader to every image", () => {
		const loader = { load: async () => "blob:x", dispose() {} } as never;
		const out = flat(renderConversation(createConversation([{ role: "user", content: [REF], timestamp: 1 }] as never), loader));
		expect(out).toContain(".loader={");
	});
});

describe("routed thinking level per reply", () => {
	const reply = (extra: Record<string, unknown>, content: unknown[]) =>
		flat(renderConversation(createConversation([{ role: "assistant", content, timestamp: 1, ...extra } as never])));

	it("puts the reply's level in the thinking line", () => {
		const out = reply({ thinkingLevel: "xhigh", stopReason: "stop" }, [{ type: "thinking", thinking: "two words" }, { type: "text", text: "done" }]);
		expect(out).toContain("thinking · xhigh · 2 words");
	});

	it("marks a final reply that used no thinking", () => {
		expect(reply({ thinkingLevel: "off", stopReason: "stop" }, [{ type: "text", text: "Hello!" }])).toContain("no thinking");
	});

	it("doesn't mark tool steps at off", () => {
		expect(reply({ thinkingLevel: "off", stopReason: "toolUse" }, [{ type: "text", text: "listing" }])).not.toContain("no thinking");
	});

	it("is unchanged when a reply has no recorded level", () => {
		const out = reply({ stopReason: "stop" }, [{ type: "thinking", thinking: "two words" }, { type: "text", text: "done" }]);
		expect(out).toContain("thinking · 2 words");
		expect(out).not.toContain("no thinking");
	});
});

describe("TL;DR line is hidden", () => {
	const reply = (content: unknown[], streaming = false) => {
		const conv = createConversation(streaming ? [] : ([{ role: "assistant", content, timestamp: 1 }] as never));
		if (streaming) conv.partial = { role: "assistant", content, timestamp: 1 } as never;
		return flat(renderConversation(conv));
	};

	it("strips the line from the last text block", () => {
		const out = reply([{ type: "text", text: "All done.\n\nTL;DR [x]: y" }]);
		expect(out).toContain("All done.");
		expect(out).not.toContain("TL;DR");
	});

	it("strips it while streaming too", () => {
		expect(reply([{ type: "text", text: "All done.\n\nTL;DR [x]: y" }], true)).not.toContain("TL;DR");
	});

	it("keeps a TL;DR line in an earlier block", () => {
		const out = reply([{ type: "text", text: "TL;DR [a]: early" }, { type: "toolCall", id: "t", name: "bash", arguments: {} }, { type: "text", text: "end" }]);
		expect(out).toContain("TL;DR");
	});

	it("strips the last text block even when a toolCall follows", () => {
		const out = reply([{ type: "text", text: "hi\n\nTL;DR [a]: b" }, { type: "toolCall", id: "t", name: "bash", arguments: {} }]);
		expect(out).not.toContain("TL;DR");
	});

	it("renders a reply without one as before", () => {
		const plain = reply([{ type: "text", text: "just text" }]);
		expect(plain).toContain("just text");
		expect(plain).toBe(flat(renderConversation(createConversation([{ role: "assistant", content: [{ type: "text", text: "just text" }], timestamp: 1 }] as never))));
	});
});
