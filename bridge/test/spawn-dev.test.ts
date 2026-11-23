// The real spawnDev + waitHealthy from preview.ts, through `npm run dev -- ...` from PATH: the dev
// server and anything it spawns share one process group, and kill() takes all of it down.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { freeLocalPort, isListening } from "../ports.ts";
import { pgidFile, spawnDev, waitHealthy } from "../preview.ts";

const app = mkdtempSync(join(tmpdir(), "preview-spawn-"));
after(() => rmSync(app, { recursive: true, force: true }));

writeFileSync(join(app, "package.json"), JSON.stringify({ name: "spawn-fixture", private: true, scripts: { dev: "node server.js" } }));
writeFileSync(
	join(app, "server.js"),
	`const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const host = process.argv[process.argv.indexOf("--host") + 1];
const grandchild = spawn("sleep", ["100"], { stdio: "ignore" });
createServer((_req, res) => res.end("fixture " + process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS)).listen(port, host, () => {
	writeFileSync("pids.json", JSON.stringify({ server: process.pid, grandchild: grandchild.pid }));
});
`,
);

/** Gone: kill(pid, 0) fails, or only a zombie is left waiting for a reaper. */
function gone(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return true;
	}
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") ?? false;
	} catch {
		return true;
	}
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
	return true;
}

test("spawnDev runs npm run dev in its own group, records the pgid, and kill takes down the grandchild too", { timeout: 60_000 }, async () => {
	// The child is unref'd (pi keeps the loop alive in production); keep this test's loop alive.
	const keep = setInterval(() => {}, 1000);
	try {
		const port = await freeLocalPort();
		const proc = spawnDev(app, port, "spark.example.ts.net", join(app, "dev.log"));
		assert.ok(proc.pid > 0);
		assert.equal(readFileSync(pgidFile(app, port), "utf8"), String(proc.pid));
		assert.equal(await waitHealthy(port, 30_000, 100), true, readFileSync(join(app, "dev.log"), "utf8"));
		assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "fixture spark.example.ts.net");
		assert.ok(await until(() => existsSync(join(app, "pids.json")), 5000));
		const pids = JSON.parse(readFileSync(join(app, "pids.json"), "utf8")) as { server: number; grandchild: number };
		assert.equal(gone(pids.server), false);
		assert.equal(gone(pids.grandchild), false);

		proc.kill();
		await proc.exited;
		assert.ok(await until(() => gone(pids.server), 5000), "server gone");
		assert.ok(await until(() => gone(pids.grandchild), 5000), "grandchild gone");
		assert.equal(await isListening(port), false);
		assert.equal(existsSync(pgidFile(app, port)), false, "pgid file removed on exit");

		// Once exited, kill() never signals the (possibly recycled) group again.
		const real = process.kill;
		const signalled: number[] = [];
		process.kill = ((pid: number, sig?: string | number) => (signalled.push(pid), real(pid, sig))) as typeof process.kill;
		try {
			proc.kill();
		} finally {
			process.kill = real;
		}
		assert.deepEqual(signalled, []);
	} finally {
		clearInterval(keep);
	}
});
