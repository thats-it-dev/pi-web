import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, PiEvent, SessionStats } from "../src/protocol.ts";
import { LiveStats } from "../src/live-stats.ts";

function clock() {
	let t = 1_000;
	return { now: () => t, tick: (ms: number) => (t += ms) };
}

function stats(tokens: number | null, contextWindow = 100_000): SessionStats {
	return {
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 2,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
		contextUsage: { tokens, contextWindow, percent: tokens == null ? null : (tokens / contextWindow) * 100 },
	};
}

const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output });
const start: PiEvent = { type: "message_start", message: { role: "assistant", content: [] } };
const delta = (text: string, u?: ReturnType<typeof usage>): PiEvent => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text }, ...(u ? { usage: u } : {}) });
const end = (message: AgentMessage): PiEvent => ({ type: "message_end", message });
const userEnd = (text: string) => end({ role: "user", content: [{ type: "text", text }] });

test("context grows by an estimate while a reply streams, and real stats replace it", () => {
	const c = clock();
	const live = new LiveStats(c.now);
	live.onStats(stats(10_000));
	assert.deepEqual(live.context(), { tokens: 10_000, contextWindow: 100_000, percent: 10, estimated: false });

	live.onEvent(userEnd("x".repeat(400))); // ~100 tokens
	live.onEvent(start);
	live.onEvent(delta("y".repeat(800))); // ~200 tokens
	assert.deepEqual(live.context(), { tokens: 10_300, contextWindow: 100_000, percent: 10.3, estimated: true });

	live.onStats(stats(10_250));
	assert.partialDeepStrictEqual(live.context(), { tokens: 10_450, estimated: true }); // the reply still streaming is kept on top
	live.onEvent(end({ role: "assistant", content: [{ type: "text", text: "y".repeat(800) }], usage: usage(10_100, 150) }));
	assert.partialDeepStrictEqual(live.context(), { tokens: 10_250, estimated: false }); // the provider's own count
});

test("speed shows after half a second of output, is throttled, and settles on the real count", () => {
	const c = clock();
	const live = new LiveStats(c.now);
	live.onEvent(start);
	live.onEvent(delta("a".repeat(40))); // first token: the clock starts here
	c.tick(300);
	live.onEvent(delta("a".repeat(40)));
	assert.equal(live.speed(), null); // too early to say

	c.tick(700); // 1s since the first token, 80 chars ≈ 20 tokens
	live.onEvent(delta("a".repeat(0)));
	assert.deepEqual(live.speed(), { tps: 20, estimated: true });

	c.tick(100); // within the 250ms throttle: the shown value holds
	live.onEvent(delta("a".repeat(400)));
	assert.deepEqual(live.speed(), { tps: 20, estimated: true });

	c.tick(900); // 2s in
	live.onEvent(end({ role: "assistant", content: [], usage: usage(1_000, 50) }));
	assert.deepEqual(live.speed(), { tps: 25, estimated: false });

	live.onEvent({ type: "agent_settled" });
	c.tick(60_000);
	assert.deepEqual(live.speed(), { tps: 25, estimated: false }); // kept after the run
});
