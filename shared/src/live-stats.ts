// Context usage and generation speed that move while a reply streams. The hub's
// stats only refresh after each turn, so between refreshes the context figure
// is the last real one plus an estimate of what has been added since (about 4
// characters per token, the rule pi uses), and speed is timed from each reply's
// first token. Provider-reported usage replaces the estimates whenever it shows up.

import type { AgentMessage, PiEvent, SessionStats } from "./protocol.ts";

const CHARS_PER_TOKEN = 4;
const IMAGE_CHARS = 1200 * CHARS_PER_TOKEN; // pi counts an image as about 1200 tokens
const SPEED_AFTER_MS = 500; // too little output before this to give a stable rate
const MIN_REPLY_MS = 250; // a reply shorter than this can't be timed meaningfully
const REFRESH_MS = 250; // the live rate changes at most four times a second

export interface LiveContext {
	tokens: number;
	contextWindow: number;
	percent: number;
	estimated: boolean;
}

export interface Speed {
	tps: number;
	estimated: boolean;
}

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

interface Reply {
	start: number | null; // when the first token we saw arrived
	chars: number; // streamed since then
	providerOutput: number; // output tokens the provider reported so far, 0 if none
}

export class LiveStats {
	private now: () => number;
	private base: number | null = null; // last real context tokens
	private contextWindow = 0;
	private addedChars = 0; // finished messages since the last real figure
	private partialChars = 0; // the reply streaming now
	private exact: number | null = null; // provider-reported context for the reply streaming now
	private reply: Reply | null = null;
	private last: Speed | null = null; // the last finished reply
	private shown: { at: number; value: Speed | null } | null = null;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	// A fresh snapshot: start from its stats; if a reply is mid-stream, time it from the next token.
	reset(stats: SessionStats | null, streaming: boolean): void {
		this.addedChars = 0;
		this.partialChars = 0;
		this.exact = null;
		this.reply = streaming ? { start: null, chars: 0, providerOutput: 0 } : null;
		this.shown = null;
		this.onStats(stats);
	}

	// The hub's real figure, which already includes every finished message.
	onStats(stats: SessionStats | null): void {
		const ctx = stats?.contextUsage;
		this.contextWindow = ctx?.contextWindow ?? this.contextWindow;
		this.base = ctx?.tokens ?? null;
		this.addedChars = 0;
	}

	onEvent(ev: PiEvent): void {
		switch (ev.type) {
			case "message_start":
				if (ev.message?.role !== "assistant") return;
				this.reply = { start: null, chars: 0, providerOutput: 0 };
				this.partialChars = 0;
				this.exact = null;
				this.shown = null;
				return;
			case "message_update": {
				const d = ev.assistantMessageEvent;
				const text = d?.type === "text_delta" || d?.type === "thinking_delta" || d?.type === "toolcall_delta" ? String(d.delta ?? "") : "";
				this.reply ??= { start: null, chars: 0, providerOutput: 0 };
				this.reply.start ??= this.now();
				this.reply.chars += text.length;
				this.partialChars += text.length;
				const u = ev.usage as Usage | undefined;
				if (u?.output) this.reply.providerOutput = u.output;
				if (u?.input) this.exact = contextFrom(u);
				return;
			}
			case "message_end": {
				const m = ev.message as AgentMessage | undefined;
				if (!m || m.role === "system") return;
				if (m.role !== "assistant") {
					this.addedChars += messageChars(m);
					return;
				}
				this.finishReply(m);
				const u = m.usage as Usage | undefined;
				if (u?.input) {
					// The provider counted the whole context for this reply.
					this.base = contextFrom(u);
					this.addedChars = 0;
				} else {
					this.addedChars += this.partialChars;
				}
				this.partialChars = 0;
				this.exact = null;
				return;
			}
		}
	}

	context(): LiveContext | null {
		if (this.exact != null) return this.make(this.exact, false);
		if (this.base == null || !this.contextWindow) return null;
		const extra = this.addedChars + this.partialChars;
		return this.make(this.base + Math.ceil(extra / CHARS_PER_TOKEN), extra > 0);
	}

	// The reply streaming now, once there's enough to time; otherwise the last finished reply.
	speed(): Speed | null {
		const now = this.now();
		if (this.shown && now - this.shown.at < REFRESH_MS) return this.shown.value;
		const r = this.reply;
		let value = this.last;
		if (r?.start != null && now - r.start >= SPEED_AFTER_MS) value = rate(r, now);
		this.shown = { at: now, value };
		return value;
	}

	private finishReply(m: AgentMessage): void {
		const r = this.reply;
		this.reply = null;
		this.shown = null;
		if (r?.start == null) return;
		const output = (m.usage as Usage | undefined)?.output;
		if (output) r.providerOutput = output;
		const elapsed = this.now() - r.start;
		if (elapsed >= MIN_REPLY_MS) this.last = rate(r, this.now());
	}

	private make(tokens: number, estimated: boolean): LiveContext {
		const window = this.contextWindow;
		return { tokens, contextWindow: window, percent: window ? Math.round((tokens / window) * 1000) / 10 : 0, estimated };
	}
}

function rate(r: Reply, now: number): Speed {
	const tokens = r.providerOutput || r.chars / CHARS_PER_TOKEN;
	const seconds = (now - (r.start ?? now)) / 1000;
	return { tps: seconds > 0 ? tokens / seconds : 0, estimated: !r.providerOutput };
}

function contextFrom(u: Usage): number {
	return (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
}

function messageChars(m: AgentMessage): number {
	const c = m.content;
	if (typeof c === "string") return c.length;
	if (!Array.isArray(c)) return 0;
	let n = 0;
	for (const b of c) {
		if (b.type === "text") n += b.text.length;
		else if (b.type === "thinking") n += b.thinking.length;
		else if (b.type === "toolCall") n += JSON.stringify(b.arguments ?? {}).length + b.name.length;
		else if (b.type === "image") n += IMAGE_CHARS;
	}
	return n;
}
