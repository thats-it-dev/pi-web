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
