import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bg from "../index.ts";

function setup() {
	const tools: Record<string, any> = {};
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	const sent: { message: any; options: any }[] = [];
	const status: [string, string | undefined][] = [];
	let notify: () => void = () => {};
	const pi = {
		registerTool: (t: any) => void (tools[t.name] = t),
		on: (e: string, h: any) => void (handlers[e] = h),
		sendMessage: (message: any, options: any) => {
			sent.push({ message, options });
			notify();
		},
	};
	bg(pi as any, { logDir: mkdtempSync(join(tmpdir(), "bg-idx-")) });
	const ctx = { cwd: process.cwd(), ui: { setStatus: (k: string, v?: string) => void status.push([k, v]) } };
	const run = (name: string, params: any) => tools[name].execute("c1", params, undefined, undefined, ctx);
	const nextMessage = () => new Promise<void>((res) => (notify = res));
	return { tools, handlers, sent, status, run, nextMessage, ctx };
}

const text = (r: any) => r.content[0].text as string;

test("registers bg_bash, bg_status, bg_cancel", () => {
	const { tools } = setup();
	assert.deepEqual(Object.keys(tools).sort(), ["bg_bash", "bg_cancel", "bg_status"]);
});

test("bg_bash returns at once with the job id and sets the bg-jobs status", async () => {
	const { run, status, nextMessage } = setup();
	const p = nextMessage();
	const r = await run("bg_bash", { command: "sleep 0.2; echo done" });
	assert.match(text(r), /started job bg-1/);
	assert.equal(r.details.id, "bg-1");
	assert.deepEqual(status[0], ["bg-jobs", "1 background job"]);
	await p;
});

test("on exit it sends one bg-bash-done message that triggers a turn and queues as follow-up", async () => {
	const { run, sent, status, nextMessage } = setup();
	const p = nextMessage();
	await run("bg_bash", { command: "echo done" });
	await p;
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, "bg-bash-done");
	assert.equal(sent[0].message.display, true);
	assert.ok(sent[0].message.content.startsWith("bg_bash job bg-1 exited 0"));
	assert.match(sent[0].message.content, /done/);
	assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.deepEqual(status.at(-1), ["bg-jobs", undefined]);
});

test("bg_status lists jobs with state and tail", async () => {
	const { run, nextMessage } = setup();
	assert.match(text(await run("bg_status", {})), /no background jobs/i);
	const p = nextMessage();
	await run("bg_bash", { command: "echo hello-tail" });
	await p;
	const all = text(await run("bg_status", {}));
	assert.match(all, /bg-1/);
	assert.match(all, /exited/);
	assert.match(all, /hello-tail/);
	assert.match(text(await run("bg_status", { id: "bg-1" })), /hello-tail/);
	assert.equal((await run("bg_status", { id: "bg-9" })).isError, true);
});

test("bg_cancel stops a job and says so", async () => {
	const { run, nextMessage } = setup();
	const p = nextMessage();
	await run("bg_bash", { command: "sleep 30" });
	const r = await run("bg_cancel", { id: "bg-1" });
	assert.match(text(r), /cancel/i);
	assert.notEqual(r.isError, true);
	await p;
});

test("bg_cancel of an unknown id is an error result", async () => {
	const { run } = setup();
	const r = await run("bg_cancel", { id: "bg-42" });
	assert.equal(r.isError, true);
	assert.match(text(r), /bg-42/);
});

test("session_shutdown kills running jobs and sends nothing", async () => {
	const { run, handlers, sent } = setup();
	await run("bg_bash", { command: "sleep 30" });
	handlers.session_shutdown({}, {});
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(sent.length, 0);
});
