import { expect, test } from "vitest";
import type { AgentMessage, PiEvent, SessionStats } from "../../../shared/src/protocol.ts";
import { LiveStats, contextLabel, speedLabel } from "./live-stats.ts";

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
	expect(live.context()).toEqual({ tokens: 10_000, contextWindow: 100_000, percent: 10, estimated: false });

	live.onEvent(userEnd("x".repeat(400))); // ~100 tokens
	live.onEvent(start);
	live.onEvent(delta("y".repeat(800))); // ~200 tokens
	expect(live.context()).toEqual({ tokens: 10_300, contextWindow: 100_000, percent: 10.3, estimated: true });

	live.onStats(stats(10_250));
	expect(live.context()).toMatchObject({ tokens: 10_450, estimated: true }); // the reply still streaming is kept on top
	live.onEvent(end({ role: "assistant", content: [{ type: "text", text: "y".repeat(800) }], usage: usage(10_100, 150) }));
	expect(live.context()).toMatchObject({ tokens: 10_250, estimated: false }); // the provider's own count
});

test("a provider that streams usage gives an exact live context", () => {
	const live = new LiveStats(clock().now);
	live.onStats(stats(5_000));
	live.onEvent(start);
	live.onEvent(delta("abc", usage(5_200, 40)));
	expect(live.context()).toMatchObject({ tokens: 5_240, estimated: false });
});

test("no known context means no live context", () => {
	const live = new LiveStats(clock().now);
	expect(live.context()).toBeNull();
	live.onStats(stats(null));
	live.onEvent(delta("abc"));
	expect(live.context()).toBeNull();
});

test("speed shows after half a second of output, is throttled, and settles on the real count", () => {
	const c = clock();
	const live = new LiveStats(c.now);
	live.onEvent(start);
	live.onEvent(delta("a".repeat(40))); // first token: the clock starts here
	c.tick(300);
	live.onEvent(delta("a".repeat(40)));
	expect(live.speed()).toBeNull(); // too early to say

	c.tick(700); // 1s since the first token, 80 chars ≈ 20 tokens
	live.onEvent(delta("a".repeat(0)));
	expect(live.speed()).toEqual({ tps: 20, estimated: true });

	c.tick(100); // within the 250ms throttle: the shown value holds
	live.onEvent(delta("a".repeat(400)));
	expect(live.speed()).toEqual({ tps: 20, estimated: true });

	c.tick(900); // 2s in
	live.onEvent(end({ role: "assistant", content: [], usage: usage(1_000, 50) }));
	expect(live.speed()).toEqual({ tps: 25, estimated: false });

	live.onEvent({ type: "agent_settled" });
	c.tick(60_000);
	expect(live.speed()).toEqual({ tps: 25, estimated: false }); // kept after the run
});

test("provider-streamed output counts are used live", () => {
	const c = clock();
	const live = new LiveStats(c.now);
	live.onEvent(start);
	live.onEvent(delta("a", usage(100, 1)));
	c.tick(1_000);
	live.onEvent(delta("b", usage(100, 31)));
	expect(live.speed()).toEqual({ tps: 31, estimated: false });
});

test("each reply in a run is measured on its own; tool time doesn't count", () => {
	const c = clock();
	const live = new LiveStats(c.now);
	live.onEvent(start);
	live.onEvent(delta("a"));
	c.tick(1_000);
	live.onEvent(end({ role: "assistant", content: [], usage: usage(100, 10) }));
	expect(live.speed()).toEqual({ tps: 10, estimated: false });

	c.tick(30_000); // a tool runs
	live.onEvent(end({ role: "toolResult", content: [{ type: "text", text: "ok" }] }));
	live.onEvent(start);
	c.tick(5_000); // time to first token isn't generation time
	live.onEvent(delta("b"));
	c.tick(2_000);
	live.onEvent(end({ role: "assistant", content: [], usage: usage(200, 100) }));
	expect(live.speed()).toEqual({ tps: 50, estimated: false });
});

test("a reply too short to time keeps the previous speed", () => {
	const c = clock();
	const live = new LiveStats(c.now);
	live.onEvent(start);
	live.onEvent(delta("a"));
	c.tick(1_000);
	live.onEvent(end({ role: "assistant", content: [], usage: usage(100, 10) }));
	live.onEvent(start);
	live.onEvent(delta("b"));
	c.tick(50);
	live.onEvent(end({ role: "assistant", content: [], usage: usage(100, 1) }));
	expect(live.speed()).toEqual({ tps: 10, estimated: false });
});

test("joining mid-reply measures from the next token", () => {
	const c = clock();
	const live = new LiveStats(c.now);
	live.reset(stats(1_000), true);
	c.tick(5_000);
	live.onEvent(delta("a".repeat(4)));
	c.tick(1_000);
	live.onEvent(end({ role: "assistant", content: [], usage: usage(900, 400) }));
	expect(live.speed()?.estimated).toBe(false); // timed from when we joined, not from the reply's real start
	expect(live.speed()?.tps).toBe(400);
});

test("labels", () => {
	expect(contextLabel({ tokens: 31_200, contextWindow: 128_000, percent: 24, estimated: true })).toBe("~31.2k / 128k");
	expect(contextLabel({ tokens: 900, contextWindow: 128_000, percent: 1, estimated: false })).toBe("900 / 128k");
	expect(speedLabel({ tps: 42.4, estimated: false })).toBe("42 tok/s");
	expect(speedLabel({ tps: 7.25, estimated: true })).toBe("~7.3 tok/s");
});
