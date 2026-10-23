import { test } from "node:test";
import assert from "node:assert/strict";
import { realRun } from "../scripts/lib/run.ts";

test("stdin is closed so a prompting command does not hang", async () => {
	const r = await realRun("node", ["-e", "process.stdin.on('end',()=>console.log('eof')).resume()"]);
	assert.equal(r.stdout.trim(), "eof");
});

test("input is passed on stdin and non-zero exit does not throw", async () => {
	const r = await realRun("node", ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.error(d);process.exit(3)})"], { input: "hi" });
	assert.equal(r.code, 3);
	assert.equal(r.stderr.trim(), "hi");
});
