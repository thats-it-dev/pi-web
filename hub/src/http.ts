// Request and response helpers shared by the app's routes (server.ts) and the watch's (watch-routes.ts).

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./errors.ts";

export type Cors = Record<string, string>;
const MAX_BODY = 50 * 1024 * 1024; // prompts can carry images

export function sendJson(res: ServerResponse, status: number, body: unknown, cors: Cors): void {
	res.writeHead(status, { ...cors, "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > MAX_BODY) throw new HttpError(413, "Request too large");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "Invalid JSON");
	}
}
