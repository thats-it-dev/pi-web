import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { freeLocalPort, isListening } from "../ports.ts";
import { PreviewManager, waitHealthy, type PreviewDeps, type PreviewDetails } from "../preview.ts";
import { startStaticServer } from "../static-server.ts";
import { Tailscale } from "../tailscale.ts";

const HOST = "spark-713a.tail9274fa.ts.net";
const STATUS = JSON.stringify({ Self: { DNSName: `${HOST}.` } });

const scratch = mkdtempSync(join(tmpdir(), "preview-mgr-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let seq = 0;

function viteApp(name = `app-${++seq}`): string {
	const dir = join(scratch, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, scripts: { dev: "vite" } }));
	return dir;
}

/** A Tailscale whose exec works on an in-memory serve table: port -> local target port. */
function fakeTailscale(serve = new Map<number, number>(), onAdd?: (port: number, local: number) => void, sync = false) {
	const calls: string[] = [];
	const handle = (cmd: string, args: string[]): string => {
		calls.push([cmd, ...args].join(" "));
		if (args[0] === "status") return STATUS;
		if (args[0] === "serve" && args[1] === "status") {
			const TCP: Record<string, unknown> = {};
			const Web: Record<string, unknown> = {};
			for (const [port, local] of serve) {
				TCP[String(port)] = { HTTPS: true };
				Web[`${HOST}:${port}`] = { Handlers: { "/": { Proxy: `http://127.0.0.1:${local}` } } };
			}
			return JSON.stringify({ TCP, Web });
		}
		const https = args.find((a) => a.startsWith("--https="));
		const port = https ? Number(https.slice("--https=".length)) : NaN;
		if (args[0] === "serve" && args[1] === "--bg") {
			serve.set(port, Number(new URL(args[3]).port));
			onAdd?.(port, Number(new URL(args[3]).port));
		} else if (args[0] === "serve" && args[2] === "off") {
			serve.delete(port);
		}
		return "";
	};
	const ts = new Tailscale(async (cmd, args) => handle(cmd, args), sync ? handle : undefined);
	return { ts, calls, serve };
}

interface Spawned {
	cwd: string;
	port: number;
	host: string;
	log: string;
	server: Server;
	killed: boolean;
}

/** spawnDev that runs a real node:http server in-process on the requested port. */
function fakeSpawn(opts: { listen?: boolean; logLines?: string[] } = {}) {
	const spawned: Spawned[] = [];
	const spawnDev: PreviewDeps["spawnDev"] = (cwd, port, host, log) => {
		writeFileSync(log, (opts.logLines ?? ["> vite", `  Local: http://127.0.0.1:${port}/`]).join("\n") + "\n");
		const server = createServer((_req, res) => res.end("<html><body>dev</body></html>"));
		if (opts.listen !== false) server.listen(port, "127.0.0.1");
		let exit!: (code: number | null) => void;
		const exited = new Promise<number | null>((r) => (exit = r));
		const rec: Spawned = { cwd, port, host, log, server, killed: false };
		spawned.push(rec);
		return {
			pid: 1000 + spawned.length,
			kill() {
				rec.killed = true;
				server.close();
				server.closeAllConnections();
				exit(null);
			},
			exited,
		};
	};
	return { spawnDev, spawned };
}

function setup(
	over: Partial<PreviewDeps> = {},
	spawnOpts: Parameters<typeof fakeSpawn>[0] = {},
	serve?: Map<number, number>,
	onAdd?: (port: number, local: number) => void,
) {
	const tail = fakeTailscale(serve, onAdd);
	const fs = fakeSpawn(spawnOpts);
	const logDir = join(scratch, `logs-${++seq}`);
	const deps: PreviewDeps = {
		tailscale: tail.ts,
		freeLocalPort,
		isListening,
		startStatic: startStaticServer,
		spawnDev: fs.spawnDev,
		waitHealthy: (port, timeoutMs) => waitHealthy(port, Math.min(timeoutMs, 3000), 25),
		logDir,
		stateDir: join(scratch, `state-${++seq}`),
		home: scratch,
		...over,
	};
	const mgr = new PreviewManager(deps);
	after(() => mgr.stop());
	return { mgr, deps, ...tail, ...fs };
}

const adds = (calls: string[]) => calls.filter((c) => c.startsWith("tailscale serve --bg"));

test("a Vite app gets a dev server, a serve entry in range and the result pi-web renders", async () => {
	const { mgr, calls, spawned, serve } = setup();
	const cwd = viteApp();
	const res = await mgr.run({ cwd }, scratch, "s1");
	assert.equal(res.isError, undefined);
	assert.deepEqual(res.details, {
		url: `https://${HOST}:10600`,
		label: basename(cwd),
		kind: "dev",
		port: 10600,
		root: cwd,
	});
	assert.match(res.content[0].text, /^Preview open at https:\/\/spark-713a\.tail9274fa\.ts\.net:10600 \(/);
	assert.match(res.content[0].text, /dev server with live reload\)\. Michael sees it in pi-web's Preview panel/);
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0].host, HOST);
	assert.equal(spawned[0].cwd, cwd);
	assert.deepEqual(adds(calls), [`tailscale serve --bg --https=10600 http://127.0.0.1:${spawned[0].port}`]);
	assert.equal(serve.get(10600), spawned[0].port);
	assert.deepEqual(mgr.current(), res.details);
	assert.equal(mgr.statusText(), `preview ${basename(cwd)} :10600`);
	await mgr.stop();
});

test("the same cwd again returns the same url without a second server", async () => {
	const { mgr, calls, spawned } = setup();
	const cwd = viteApp();
	const first = await mgr.run({ cwd }, scratch, "s1");
	const second = await mgr.run({ cwd: basename(cwd) }, scratch, "s1");
	assert.equal(spawned.length, 1);
	assert.ok(second.content[0].text.startsWith("Preview already open at"), second.content[0].text);
	assert.deepEqual(second.details, first.details);
	assert.equal(adds(calls).length, 1);
	await mgr.stop();
});

test("a different cwd stops the first preview and takes one port", async () => {
	const { mgr, calls, spawned, serve } = setup();
	const a = viteApp();
	const b = viteApp();
	await mgr.run({ cwd: a }, scratch, "s1");
	const res = await mgr.run({ cwd: b }, scratch, "s1");
	assert.equal(spawned.length, 2);
	assert.equal(spawned[0].killed, true);
	const removeAt = calls.indexOf("tailscale serve --https=10600 off");
	const secondAdd = calls.lastIndexOf(`tailscale serve --bg --https=10600 http://127.0.0.1:${spawned[1].port}`);
	assert.ok(removeAt >= 0, "remove(10600) called");
	assert.ok(secondAdd > removeAt, "add(10600) after remove(10600)");
	assert.equal((res.details as PreviewDetails).port, 10600);
	assert.equal(mgr.current()?.root, b);
	assert.deepEqual([...serve.keys()], [10600]);
	await mgr.stop();
});

test("a dead dev server is noticed and restarted; its serve entry is reconciled", async () => {
	const { mgr, calls, spawned, serve } = setup();
	const cwd = viteApp();
	await mgr.run({ cwd }, scratch, "s1");
	// The server dies out of band; the serve table still points 10600 at its dead local port.
	await new Promise<void>((r) => {
		spawned[0].server.close(() => r());
		spawned[0].server.closeAllConnections();
	});
	assert.equal(serve.get(10600), spawned[0].port);
	assert.equal(await isListening(spawned[0].port), false);
	const res = await mgr.run({ cwd }, scratch, "s1");
	assert.equal(res.isError, undefined);
	assert.match(res.content[0].text, /^Preview open at /);
	assert.equal(spawned.length, 2);
	const removeAt = calls.indexOf("tailscale serve --https=10600 off");
	const secondAdd = calls.lastIndexOf(`tailscale serve --bg --https=10600 http://127.0.0.1:${spawned[1].port}`);
	assert.ok(removeAt >= 0, "remove(10600) called");
	assert.ok(secondAdd > removeAt, "add(10600) after remove(10600)");
	assert.equal(serve.get(10600), spawned[1].port);
	assert.equal(await isListening(spawned[1].port), true);
	await mgr.stop();
});

test("reconcile clears a dead entry left by another session before picking the port", async () => {
	const deadLocal = await freeLocalPort();
	assert.equal(await isListening(deadLocal), false);
	const { mgr, calls, spawned, serve } = setup({}, {}, new Map([[10600, deadLocal]]));
	assert.equal(mgr.current(), null);
	const res = await mgr.run({ cwd: viteApp() }, scratch, "s1");
	assert.equal(res.isError, undefined);
	assert.equal((res.details as PreviewDetails).port, 10600);
	const removeAt = calls.indexOf("tailscale serve --https=10600 off");
	const addAt = calls.indexOf(`tailscale serve --bg --https=10600 http://127.0.0.1:${spawned[0].port}`);
	assert.ok(removeAt >= 0, "reconcile issued remove(10600)");
	assert.ok(addAt > removeAt, "add(10600) after remove(10600)");
	assert.equal(serve.get(10600), spawned[0].port);
	await mgr.stop();
});

test("stopping a dead preview leaves a port another session has since taken", async () => {
	const { mgr, calls, spawned, serve } = setup();
	await mgr.run({ cwd: viteApp() }, scratch, "s1");
	await new Promise<void>((r) => {
		spawned[0].server.close(() => r());
		spawned[0].server.closeAllConnections();
	});
	// Another session's reconcile cleared the dead entry and re-added 10600 for its own live server.
	const other = createServer((_req, res) => res.end("other"));
	await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
	after(() => other.close());
	const otherPort = (other.address() as { port: number }).port;
	serve.set(10600, otherPort);
	const before = calls.length;
	const res = await mgr.run({ stop: true }, scratch, "s1");
	assert.deepEqual(res.details, { stopped: true });
	assert.equal(mgr.current(), null);
	assert.ok(!calls.slice(before).includes("tailscale serve --https=10600 off"), calls.slice(before).join("\n"));
	assert.equal(serve.get(10600), otherPort);
});

test("no dev script is an error and starts nothing", async () => {
	const { mgr, calls, spawned } = setup();
	const dir = join(scratch, `plain-${++seq}`);
	mkdirSync(dir);
	const res = await mgr.run({ cwd: dir }, scratch, "s1");
	assert.equal(res.isError, true);
	assert.equal(res.content[0].text, `${dir} has no dev script; pass dir for a static folder or cwd of a Vite app.`);
	writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
	const again = await mgr.run({ cwd: dir }, scratch, "s1");
	assert.equal(again.isError, true);
	assert.equal(spawned.length, 0);
	assert.equal(adds(calls).length, 0);
	assert.equal(mgr.current(), null);
});

test("a static dir is served with live reload and labelled by its folder", async () => {
	const { mgr, calls, spawned } = setup();
	const dir = join(scratch, `mock-${++seq}`);
	mkdirSync(dir);
	writeFileSync(join(dir, "index.html"), "<html><body><h1>mock</h1></body></html>");
	const res = await mgr.run({ dir }, scratch, "s1");
	assert.equal(res.isError, undefined);
	const d = res.details as PreviewDetails;
	assert.equal(d.kind, "static");
	assert.equal(d.label, basename(dir));
	assert.equal(d.root, dir);
	assert.equal(d.url, `https://${HOST}:10600`);
	assert.match(res.content[0].text, /static folder with live reload/);
	assert.equal(spawned.length, 0);
	const add = adds(calls)[0];
	const local = Number(new URL(add.split(" ").pop()!).port);
	const page = await (await fetch(`http://127.0.0.1:${local}/`)).text();
	assert.match(page, /<h1>mock<\/h1>/);
	assert.match(page, /__preview\/version/);
	await mgr.stop();
	assert.equal(await isListening(local), false);
});

test("file serves its folder and the url opens that file", async () => {
	const { mgr, serve } = setup();
	const dir = join(scratch, `mockfile-${++seq}`);
	mkdirSync(dir);
	writeFileSync(join(dir, "my mock.html"), "<html><body>the file m</body></html>");
	const res = await mgr.run({ file: join(dir, "my mock.html") }, scratch, "s1");
	assert.equal(res.isError, undefined);
	const d = res.details as PreviewDetails;
	assert.equal(d.root, dir);
	assert.equal(d.label, "my mock.html");
	assert.equal(d.kind, "static");
	assert.equal(d.url, `https://${HOST}:10600/my%20mock.html`);
	assert.match(res.content[0].text, /^Preview open at https:\/\/\S+:10600\/my%20mock\.html \(/);
	const local = serve.get(10600)!;
	const page = await fetch(`http://127.0.0.1:${local}${new URL(d.url).pathname}`);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /the file m/);
	await mgr.stop();
});

test("file must be a regular file", async () => {
	const { mgr, calls } = setup();
	const dir = join(scratch, `notafile-${++seq}`);
	mkdirSync(dir);
	const res = await mgr.run({ file: dir }, scratch, "s1");
	assert.equal(res.isError, true);
	assert.equal(res.content[0].text, `${dir} is not a file.`);
	const missing = await mgr.run({ file: join(dir, "nope.html") }, scratch, "s1");
	assert.equal(missing.isError, true);
	assert.ok(missing.content[0].text.includes(join(dir, "nope.html")));
	assert.equal(adds(calls).length, 0);
});

test("a leading ~ in cwd, dir and file is the home folder", async () => {
	const { mgr } = setup();
	const name = `tilde-${++seq}`;
	const app = viteApp(name);
	const res = await mgr.run({ cwd: `~/${name}` }, "/somewhere/else", "s1");
	assert.equal(res.isError, undefined, res.content[0].text);
	assert.equal((res.details as PreviewDetails).root, app);
	writeFileSync(join(app, "page.html"), "<body>p</body>");
	const file = await mgr.run({ file: `~/${name}/page.html` }, "/somewhere/else", "s1");
	assert.equal((file.details as PreviewDetails).root, app);
	const dir = await mgr.run({ dir: "~" }, "/somewhere/else", "s1");
	assert.equal((dir.details as PreviewDetails).root, scratch);
	await mgr.stop();
});

test("stop removes the entry and clears current", async () => {
	const { mgr, calls, serve, spawned } = setup();
	await mgr.run({ cwd: viteApp() }, scratch, "s1");
	const res = await mgr.run({ stop: true }, scratch, "s1");
	assert.equal(res.isError, undefined);
	assert.equal(res.content[0].text, "Preview stopped.");
	assert.deepEqual(res.details, { stopped: true });
	assert.equal(mgr.current(), null);
	assert.equal(mgr.statusText(), undefined);
	assert.ok(calls.includes("tailscale serve --https=10600 off"));
	assert.equal(serve.size, 0);
	assert.equal(spawned[0].killed, true);
	const idle = await mgr.run({ stop: true }, scratch, "s1");
	assert.equal(idle.isError, undefined);
	assert.equal(idle.content[0].text, "Preview stopped.");
	assert.deepEqual(idle.details, { stopped: true });
});

test("no arguments gives the mockup folder for the session", async () => {
	const { mgr, calls } = setup();
	const res = await mgr.run({}, scratch, "sess-1");
	const dir = join(scratch, ".pi", "agent", "tmp", "previews", "sess-1");
	assert.equal(res.isError, undefined);
	assert.equal(res.details, undefined);
	assert.ok(res.content[0].text.includes("previews/sess-1"));
	assert.equal(res.content[0].text, `Mockup folder: ${dir}. Write index.html there, then call preview({ dir: "${dir}" }).`);
	assert.ok(existsSync(dir));
	assert.equal(PreviewManager.mockupDir(scratch, "sess-1"), dir);
	assert.equal(adds(calls).length, 0);
});

test("health timeout kills the server and reports the log tail", async () => {
	const lines = Array.from({ length: 30 }, (_, i) => `log line ${i + 1}`);
	const { mgr, calls, spawned } = setup({ waitHealthy: async () => false }, { listen: false, logLines: lines });
	const res = await mgr.run({ cwd: viteApp() }, scratch, "s1");
	assert.equal(res.isError, true);
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0].killed, true);
	const text = res.content[0].text;
	assert.ok(text.includes("log line 11\n"), text);
	assert.ok(text.endsWith("log line 30"), text);
	assert.ok(!text.includes("log line 10\n"), text);
	assert.equal(adds(calls).length, 0);
	assert.equal(mgr.current(), null);
});

const tick = () => new Promise((r) => setTimeout(r, 5));

test("two sessions starting at once end on different ports, each entry targeting its own server", async () => {
	const serve = new Map<number, number>();
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	// A's health wait only ends after B has picked, started and added its port.
	const a = setup({ waitHealthy: async (port) => (await gate, waitHealthy(port, 3000, 25)) }, {}, serve);
	const b = setup({}, {}, serve);
	const pa = a.mgr.run({ cwd: viteApp() }, scratch, "sA");
	while (a.spawned.length === 0) await tick();
	const rb = await b.mgr.run({ cwd: viteApp() }, scratch, "sB");
	release();
	const ra = await pa;
	assert.equal(ra.isError, undefined, ra.content[0].text);
	assert.equal(rb.isError, undefined, rb.content[0].text);
	const pA = (ra.details as PreviewDetails).port;
	const pB = (rb.details as PreviewDetails).port;
	assert.notEqual(pA, pB);
	assert.equal(serve.get(pA), a.spawned[0].port);
	assert.equal(serve.get(pB), b.spawned[0].port);
	await a.mgr.stop();
	await b.mgr.stop();
});

test("a port overwritten right after our add is re-picked once", async () => {
	const serve = new Map<number, number>();
	const other = await freeLocalPort();
	let hijacked = false;
	// Another session's add lands on 10600 just after ours.
	const onAdd = (port: number) => {
		if (port === 10600 && !hijacked) {
			hijacked = true;
			serve.set(10600, other);
		}
	};
	const { mgr, spawned } = setup({}, {}, serve, onAdd);
	const res = await mgr.run({ cwd: viteApp() }, scratch, "s1");
	assert.equal(res.isError, undefined, res.content[0].text);
	assert.equal((res.details as PreviewDetails).port, 10601);
	assert.equal(serve.get(10601), spawned[0].port);
	assert.equal(serve.get(10600), other);
	await mgr.stop();
});

test("losing the port twice closes our server and is an error", async () => {
	const serve = new Map<number, number>();
	const other = await freeLocalPort();
	const onAdd = (port: number) => void serve.set(port, other);
	const { mgr, spawned } = setup({}, {}, serve, onAdd);
	const res = await mgr.run({ cwd: viteApp() }, scratch, "s1");
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /Could not claim a preview port in 10600-10649/);
	assert.equal(spawned[0].killed, true);
	assert.equal(mgr.current(), null);
});

function deadPid(): number {
	for (let pid = 2 ** 22 - 1; pid > 1000; pid--) {
		try {
			process.kill(pid, 0);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ESRCH") return pid;
		}
	}
	throw new Error("no dead pid found");
}

function sleeper(): ChildProcess {
	const child = spawn("sleep", ["100"], { detached: true, stdio: "ignore" });
	after(() => {
		try {
			process.kill(-child.pid!, "SIGKILL");
		} catch {
			// gone
		}
	});
	return child;
}

function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((r) => {
		const t = setTimeout(() => r(false), ms);
		child.once("exit", () => (clearTimeout(t), r(true)));
	});
}

test("an expose kills the dev servers of dead pi processes and leaves live owners alone", async () => {
	const stateDir = join(scratch, `state-orphans-${++seq}`);
	const dead = deadPid();
	const deadDir = join(stateDir, String(dead));
	const liveDir = join(stateDir, String(process.ppid));
	const ownDir = join(stateDir, String(process.pid));
	for (const d of [deadDir, liveDir, ownDir]) mkdirSync(d, { recursive: true });
	const orphan = sleeper();
	const liveChild = sleeper();
	const ownChild = sleeper();
	writeFileSync(join(deadDir, "pgid-5173"), String(orphan.pid));
	writeFileSync(join(deadDir, "preview-10600.log"), "old log");
	writeFileSync(join(liveDir, "pgid-5174"), String(liveChild.pid));
	writeFileSync(join(ownDir, "pgid-5175"), String(ownChild.pid));
	const { mgr } = setup({ stateDir });
	const res = await mgr.run({ cwd: viteApp() }, scratch, "s1");
	assert.equal(res.isError, undefined, res.content[0].text);
	assert.equal(await exitedWithin(orphan, 3000), true, "orphan killed");
	assert.equal(orphan.signalCode, "SIGTERM");
	assert.equal(existsSync(deadDir), false);
	assert.equal(existsSync(join(liveDir, "pgid-5174")), true);
	assert.equal(existsSync(join(ownDir, "pgid-5175")), true);
	assert.equal(await exitedWithin(liveChild, 200), false, "live owner's server untouched");
	assert.equal(await exitedWithin(ownChild, 50), false, "own server untouched");
	await mgr.stop();
});

test("killNow also removes the serve entry synchronously when tailscale can run that way; another session's entry on the port is left", async () => {
	const serve = new Map<number, number>();
	const tail = fakeTailscale(serve, undefined, true);
	const { mgr } = setup({ tailscale: tail.ts });
	const dir = join(scratch, `killsync-${++seq}`);
	mkdirSync(dir);
	writeFileSync(join(dir, "index.html"), "<body>k</body>");
	await mgr.run({ dir }, scratch, "s1");
	assert.equal(serve.has(10600), true);
	mgr.killNow();
	assert.equal(serve.has(10600), false, "the entry is gone before any await");
	assert.ok(tail.calls.at(-1)?.startsWith("tailscale serve --https=10600 off"));
	// A second run, then another session takes the port over before our killNow: not ours to remove.
	await mgr.run({ dir }, scratch, "s1");
	serve.set(10600, 1);
	mgr.killNow();
	assert.equal(serve.get(10600), 1);
});

test("killNow closes a static server synchronously; stop then removes the entry", async () => {
	const { mgr, serve } = setup();
	const dir = join(scratch, `kill-${++seq}`);
	mkdirSync(dir);
	writeFileSync(join(dir, "index.html"), "<body>k</body>");
	await mgr.run({ dir }, scratch, "s1");
	const local = serve.get(10600)!;
	assert.equal(await isListening(local), true);
	mgr.killNow();
	assert.equal(mgr.current(), null);
	assert.equal(await isListening(local), false);
	await mgr.stop();
	assert.equal(serve.size, 0);
});

test("killNow kills a running dev server and its pgid file, and one still in its health wait", async () => {
	const { mgr, spawned, deps, serve } = setup();
	await mgr.run({ cwd: viteApp() }, scratch, "s1");
	writeFileSync(join(deps.logDir, `pgid-${spawned[0].port}`), "1001");
	mgr.killNow();
	assert.equal(spawned[0].killed, true);
	assert.equal(existsSync(join(deps.logDir, `pgid-${spawned[0].port}`)), false);
	await mgr.stop();
	assert.equal(serve.size, 0);

	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const slow = setup({ waitHealthy: async (port) => (await gate, waitHealthy(port, 3000, 25)) });
	const pending = slow.mgr.run({ cwd: viteApp() }, scratch, "s2");
	while (slow.spawned.length === 0) await tick();
	slow.mgr.killNow();
	assert.equal(slow.spawned[0].killed, true);
	release();
	const res = await pending;
	assert.equal(res.isError, true);
	assert.equal(adds(slow.calls).length, 0);
	assert.equal(slow.mgr.current(), null);
});

test("a server that does not answer on its port is an error, never \"Preview open\"; the entry is removed", async () => {
	const { mgr, serve } = setup({ startStatic: async () => ({ port: 1, close: async () => {} }) });
	const dir = join(scratch, `static-dead-${++seq}`);
	mkdirSync(dir);
	writeFileSync(join(dir, "index.html"), "<body>x</body>");
	const res = await mgr.run({ dir }, scratch, "s1");
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /not answering, so the preview is not open/);
	assert.equal(mgr.current(), null);
	assert.deepEqual([...serve.keys()], [], "the claimed port was given back");
});
