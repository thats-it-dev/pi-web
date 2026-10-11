import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { lineSplitter } from "../src/jsonl.ts";
import { type FakeModel, startFakeModel } from "./support/fake-model.ts";
import { makePiEnv } from "./support/pi-env.ts";

let model: FakeModel;
before(async () => {
	model = await startFakeModel();
});
after(() => model.close());

test("real pi in RPC mode streams the fake model's reply", async () => {
	const env = makePiEnv({ modelUrl: model.url });
	try {
		const proc = spawn(env.piBin, ["--mode", "rpc", "--no-session"], { cwd: env.workDir, env: { ...process.env, ...env.env } });
		const records: Array<{ type: string; assistantMessageEvent?: { type: string; delta?: string } }> = [];
		const settled = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("pi did not settle within 20s")), 20_000);
			proc.stdout.setEncoding("utf8");
			proc.stdout.on(
				"data",
				lineSplitter((line) => {
					const rec = JSON.parse(line);
					records.push(rec);
					if (rec.type === "agent_settled") {
						clearTimeout(timer);
						resolve();
					}
				}),
			);
		});
		proc.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: "hi" })}\n`);
		await settled;
		proc.stdin.end();
		const text = records
			.filter((r) => r.assistantMessageEvent?.type === "text_delta")
			.map((r) => r.assistantMessageEvent?.delta)
			.join("");
		assert.equal(text, "Hello world");
		assert.equal(model.requests.at(-1)?.model, "fake-a");
	} finally {
		env.cleanup();
	}
});
