// A scripted OpenAI-compatible chat-completions server. pi talks to it through
// a "fake" provider in a temp models.json, so tests are fast, deterministic and
// never touch the real models on spark.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface FakeRequest {
	model: string;
	messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
	tools?: unknown[];
}

export interface FakeReply {
	thinking?: string;
	text?: string;
	toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
	chunkDelayMs?: number;
	status?: number; // non-200 → JSON error response
}

export type FakeScript = (req: FakeRequest, n: number) => FakeReply;

export interface FakeModel {
	url: string;
	requests: FakeRequest[];
	setScript(script: FakeScript): void;
	close(): Promise<void>;
}

export const HELLO: FakeScript = () => ({ thinking: "pondering", text: "Hello world" });

export async function startFakeModel(script: FakeScript = HELLO): Promise<FakeModel> {
	let current = script;
	const requests: FakeRequest[] = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		if (!req.url?.endsWith("/chat/completions")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [] }));
			return;
		}
		const parsed = JSON.parse(body) as FakeRequest;
		requests.push(parsed);
		const reply = current(parsed, requests.length);
		if (reply.status && reply.status !== 200) {
			res.writeHead(reply.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `fake error ${reply.status}` } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
		let closed = false;
		res.on("close", () => {
			closed = true;
		});
		const send = async (choices: unknown[], extra: object = {}) => {
			if (closed) return;
			res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: parsed.model, choices, ...extra })}\n\n`);
			if (reply.chunkDelayMs) await sleep(reply.chunkDelayMs);
		};
		const delta = (d: object, finish: string | null = null) => send([{ index: 0, delta: d, finish_reason: finish }]);
		await delta({ role: "assistant" });
		if (reply.thinking) await delta({ reasoning_content: reply.thinking });
		for (const word of reply.text?.match(/\S+\s*/g) ?? []) await delta({ content: word });
		for (const [index, call] of (reply.toolCalls ?? []).entries()) {
			await delta({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
		}
		await delta({}, reply.toolCalls?.length ? "tool_calls" : "stop");
		await send([], { usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
		if (!closed) res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		setScript: (s) => {
			current = s;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
