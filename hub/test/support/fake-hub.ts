// The hub's end of the bridge socket, for bridge tests: records what bridges
// send and lets the test send commands and notices back.

import { rmSync } from "node:fs";
import { type Socket, createServer } from "node:net";
import { lineSplitter } from "../../../shared/src/jsonl.ts";
import { Recorder } from "./recorder.ts";

export interface FakeHub {
	messages: Recorder<any>;
	connections(): number; // ever accepted
	send(msg: unknown): void; // to the most recent connection
	dropClients(): void;
	close(): Promise<void>;
}

export async function fakeHub(path: string): Promise<FakeHub> {
	const messages = new Recorder<any>();
	const sockets: Socket[] = [];
	let accepted = 0;
	const server = createServer((sock) => {
		accepted++;
		sockets.push(sock);
		sock.setEncoding("utf8");
		sock.on("data", lineSplitter((line) => messages.push(JSON.parse(line))));
		sock.on("error", () => {});
	});
	rmSync(path, { force: true });
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return {
		messages,
		connections: () => accepted,
		send: (msg) => sockets.at(-1)?.write(`${JSON.stringify(msg)}\n`),
		dropClients: () => {
			for (const s of sockets.splice(0)) s.destroy();
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of sockets.splice(0)) s.destroy();
				server.close(() => resolve());
			}),
	};
}
