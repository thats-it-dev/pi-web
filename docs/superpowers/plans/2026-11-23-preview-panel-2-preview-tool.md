# Preview Panel, Plan 2 of 4: The `preview` Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pi tool `preview` in the bridge extension that starts an app's Vite dev server (or static-serves a mockup folder), exposes it on the tailnet over HTTPS through `tailscale serve` on a port in 10600–10649, waits for it to answer, and returns the URL in a result the app renders.

**Architecture:** Four small modules under `bridge/`: `ports.ts` (free local port, range allocation, listening check), `tailscale.ts` (serve add/remove/status/host behind an injectable `exec`), `static-server.ts` (Node `http` static server with an mtime-poll live reload), and `preview.ts` (`PreviewManager`: one preview per pi process, detached dev-server process group, health wait, stop, reconciliation). `index.ts` registers the tool and the `session_shutdown` cleanup. Tests are `node --test` with a fake `tailscale` exec and real local servers.

**Tech Stack:** Node 22+ (`node:http`, `node:child_process`, `node:net`), typebox for the tool schema, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-23-preview-panel-design.md` (sections "Behind the URL", "The tool", "Exposure", "Lifecycle mechanics", "Subagent workers don't get the tool").

## Global Constraints

- Serve port range is exactly 10600–10649; the tool never touches a `tailscale serve` entry outside it.
- Tailnet only: `tailscale serve` (never `funnel`), `--bg`, `--https=<port>`, target `http://127.0.0.1:<local>`.
- The dev server binds 127.0.0.1 only. Env for Vite: `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=<host>`.
- The URL is `https://<Self.DNSName without trailing dot>:<port>`; nothing hard-codes `spark-713a`.
- Health wait timeout 30 s; the tool errors (isError) with the last 20 log lines when it expires.
- The preview's status key is `preview`, never `bg-jobs`.
- Under `PI_SUBAGENT_CHILD` the tool returns an error result and starts nothing.
- No new npm dependencies.

## Review Focus

1. Second `preview({cwd})` for the same cwd while the first runs: must return the same URL without starting a second server. Test in Task 4.
2. `preview({cwd})` for a different cwd while one runs: the old server and its serve entry are stopped first; only one port in use per session. Test in Task 4.
3. A dev server that dies on its own (port conflict, crash): the next `preview` call must notice (`running` false) and start fresh; the stale serve entry must be removed by reconciliation. Test in Task 4.
4. `tailscale serve status --json` lists a stale 10600 entry from a crashed session whose local port no longer listens, plus a live 9502 gateway entry: reconciliation removes 10600 only. Test in Task 2.
5. A `cwd` without `package.json` or without a `dev` script: a clear error, no process started. Test in Task 4.

---

### Task 1: `ports.ts`

**Files:**
- Create: `bridge/ports.ts`
- Test: `bridge/test/ports.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SERVE_PORT_MIN = 10600;
  export const SERVE_PORT_MAX = 10649;
  /** A free TCP port on 127.0.0.1 (listen on 0, read the port, close). */
  export function freeLocalPort(): Promise<number>;
  /** Whether something accepts a TCP connection on 127.0.0.1:port (500 ms timeout). */
  export function isListening(port: number): Promise<boolean>;
  /** The lowest port in [SERVE_PORT_MIN, SERVE_PORT_MAX] not in `taken`; null when all are. */
  export function pickServePort(taken: Iterable<number>): number | null;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { SERVE_PORT_MAX, SERVE_PORT_MIN, freeLocalPort, isListening, pickServePort } from "../ports.ts";

test("the range is 10600-10649 and pickServePort takes the lowest free one", () => {
	assert.deepEqual([SERVE_PORT_MIN, SERVE_PORT_MAX], [10600, 10649]);
	assert.equal(pickServePort([]), 10600);
	assert.equal(pickServePort([10600, 10601, 9502]), 10602);
	const all = Array.from({ length: 50 }, (_, i) => 10600 + i);
	assert.equal(pickServePort(all), null);
});

test("freeLocalPort returns a port nothing listens on; isListening sees a server", async () => {
	const port = await freeLocalPort();
	assert.ok(port > 0);
	assert.equal(await isListening(port), false);
	const srv = createServer().listen(port, "127.0.0.1");
	await new Promise((r) => srv.once("listening", r));
	assert.equal(await isListening(port), true);
	srv.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd bridge && node --test test/ports.test.ts`
Expected: FAIL, cannot find module `../ports.ts`.

- [ ] **Step 3: Implement `bridge/ports.ts`** with the signatures above (`node:net` only).

- [ ] **Step 4: Run to verify pass**

Run: `cd bridge && node --test test/ports.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/ports.ts bridge/test/ports.test.ts
git commit -m "bridge: port helpers for previews (free local port, 10600-10649 allocation)"
```

---

### Task 2: `tailscale.ts`

**Files:**
- Create: `bridge/tailscale.ts`
- Test: `bridge/test/tailscale.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Runs a command and resolves with stdout; rejects on a non-zero exit with stderr in the message. */
  export type Exec = (cmd: string, args: string[]) => Promise<string>;
  export const defaultExec: Exec; // execFile with a 15 s timeout
  export interface ServeEntry { port: number; target: string } // target like "http://127.0.0.1:5173"
  export class Tailscale {
  	constructor(exec?: Exec);
  	/** Self.DNSName from `tailscale status --json`, trailing dot stripped. */
  	host(): Promise<string>;
  	/** HTTPS proxy entries from `tailscale serve status --json` (TCP[port].HTTPS true + Web["host:port"].Handlers["/"].Proxy). */
  	entries(): Promise<ServeEntry[]>;
  	/** `tailscale serve --bg --https=<port> http://127.0.0.1:<local>` */
  	add(port: number, local: number): Promise<void>;
  	/** `tailscale serve --https=<port> off` */
  	remove(port: number): Promise<void>;
  	/** Removes entries in [min, max] whose target port is not listening; returns the ports removed. */
  	reconcile(range: { min: number; max: number }, listening: (port: number) => Promise<boolean>): Promise<number[]>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Tailscale } from "../tailscale.ts";

const STATUS = JSON.stringify({ Self: { DNSName: "spark-713a.tail9274fa.ts.net." } });
const SERVE = JSON.stringify({
	TCP: { "9502": { HTTPS: true }, "10600": { HTTPS: true }, "10601": { HTTPS: true } },
	Web: {
		"spark-713a.tail9274fa.ts.net:9502": { Handlers: { "/": { Proxy: "http://127.0.0.1:19502" } } },
		"spark-713a.tail9274fa.ts.net:10600": { Handlers: { "/": { Proxy: "http://127.0.0.1:41000" } } },
		"spark-713a.tail9274fa.ts.net:10601": { Handlers: { "/": { Proxy: "http://127.0.0.1:41001" } } },
	},
});

function fake() {
	const calls: string[][] = [];
	const ts = new Tailscale(async (cmd, args) => {
		calls.push([cmd, ...args]);
		if (args[0] === "status") return STATUS;
		if (args[0] === "serve" && args[1] === "status") return SERVE;
		return "";
	});
	return { ts, calls };
}

test("host strips the trailing dot", async () => {
	assert.equal(await fake().ts.host(), "spark-713a.tail9274fa.ts.net");
});

test("entries lists https proxies by port", async () => {
	assert.deepEqual(await fake().ts.entries(), [
		{ port: 9502, target: "http://127.0.0.1:19502" },
		{ port: 10600, target: "http://127.0.0.1:41000" },
		{ port: 10601, target: "http://127.0.0.1:41001" },
	]);
});

test("add and remove run the serve commands", async () => {
	const { ts, calls } = fake();
	await ts.add(10602, 5173);
	await ts.remove(10602);
	assert.deepEqual(calls, [
		["tailscale", "serve", "--bg", "--https=10602", "http://127.0.0.1:5173"],
		["tailscale", "serve", "--https=10602", "off"],
	]);
});

test("reconcile removes dead entries in range only", async () => {
	const { ts, calls } = fake();
	const removed = await ts.reconcile({ min: 10600, max: 10649 }, async (port) => port === 41001);
	assert.deepEqual(removed, [10600]);
	assert.ok(calls.some((c) => c.join(" ") === "tailscale serve --https=10600 off"));
	assert.ok(!calls.some((c) => c.includes("--https=9502")));
});
```

- [ ] **Step 2: Run to verify failure** — `cd bridge && node --test test/tailscale.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement `bridge/tailscale.ts`** per the interface. `entries()` reads `Web` keys as `host:port`, takes the port after the last colon, keeps those with `TCP[port].HTTPS === true`, sorted by port.

- [ ] **Step 4: Run to verify pass** — same command → PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/tailscale.ts bridge/test/tailscale.test.ts
git commit -m "bridge: tailscale serve wrapper (host, entries, add, remove, reconcile)"
```

---

### Task 3: `static-server.ts`

**Files:**
- Create: `bridge/static-server.ts`
- Test: `bridge/test/static-server.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface StaticServer { port: number; close(): Promise<void> }
  /** Serves `root` on 127.0.0.1 at a free port. `/` and directory paths serve index.html; `.html` responses get the
   *  reload script appended before </body>; GET /__preview/version answers {"version":<max mtimeMs under root>}. */
  export function startStaticServer(root: string): Promise<StaticServer>;
  export const RELOAD_SCRIPT: string; // polls /__preview/version every 1000 ms; location.reload() when it changes
  export const MIME: Record<string, string>; // html, css, js, mjs, json, svg, png, jpg, jpeg, gif, webp, ico, txt, md, woff2, wasm
  ```
  Paths resolve under `root` only (a `..` escape answers 404). Unknown extension: `application/octet-stream`. Missing file: 404.

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startStaticServer } from "../static-server.ts";

const root = mkdtempSync(join(tmpdir(), "preview-static-"));
writeFileSync(join(root, "index.html"), "<html><body><h1>hi</h1></body></html>");
mkdirSync(join(root, "sub"));
writeFileSync(join(root, "sub", "index.html"), "<body>sub</body>");
writeFileSync(join(root, "a.css"), "h1{}");
after(() => rmSync(root, { recursive: true, force: true }));

test("serves index.html with the reload script, css with its type, 404 for missing and escapes", async () => {
	const s = await startStaticServer(root);
	try {
		const base = `http://127.0.0.1:${s.port}`;
		const home = await fetch(`${base}/`);
		assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
		const text = await home.text();
		assert.match(text, /<h1>hi<\/h1>/);
		assert.match(text, /__preview\/version/);
		assert.match(await (await fetch(`${base}/sub/`)).text(), /sub/);
		assert.equal((await fetch(`${base}/a.css`)).headers.get("content-type"), "text/css; charset=utf-8");
		assert.equal((await fetch(`${base}/nope.html`)).status, 404);
		assert.equal((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status, 404);
	} finally {
		await s.close();
	}
});

test("the version endpoint changes when a file changes", async () => {
	const s = await startStaticServer(root);
	try {
		const url = `http://127.0.0.1:${s.port}/__preview/version`;
		const v1 = (await (await fetch(url)).json()).version as number;
		const later = new Date(Date.now() + 5000);
		utimesSync(join(root, "a.css"), later, later);
		const v2 = (await (await fetch(url)).json()).version as number;
		assert.ok(v2 > v1);
	} finally {
		await s.close();
	}
});
```

- [ ] **Step 2: Run to verify failure** — `cd bridge && node --test test/static-server.test.ts` → FAIL.

- [ ] **Step 3: Implement `bridge/static-server.ts`** with `node:http`, `node:fs/promises`, `node:path`. The version walk is recursive over `root`, skipping `node_modules` and dot-directories.

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/static-server.ts bridge/test/static-server.test.ts
git commit -m "bridge: static mockup server with mtime-poll live reload"
```

---

### Task 4: `PreviewManager` in `preview.ts`

**Files:**
- Create: `bridge/preview.ts`
- Test: `bridge/test/preview.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (the tool's result shape is what plan 3 renders; keep it exact):
  ```ts
  export interface PreviewParams { cwd?: string; dir?: string; file?: string; stop?: boolean }
  export type PreviewKind = "dev" | "static";
  export interface PreviewDetails { url: string; label: string; kind: PreviewKind; port: number; root: string }
  export interface PreviewStopped { stopped: true }
  export interface ToolResult { content: { type: "text"; text: string }[]; details?: PreviewDetails | PreviewStopped | { error: string }; isError?: boolean }
  export interface PreviewDeps {
  	tailscale: Tailscale;                       // Task 2
  	freeLocalPort: () => Promise<number>;        // Task 1
  	isListening: (port: number) => Promise<boolean>;
  	startStatic: (root: string) => Promise<StaticServer>; // Task 3
  	spawnDev: (cwd: string, port: number, host: string, log: string) => { pid: number; kill(): void; exited: Promise<number | null> }; // detached `npm run dev -- --host 127.0.0.1 --port <port> --strictPort`
  	waitHealthy: (port: number, timeoutMs: number) => Promise<boolean>; // GET http://127.0.0.1:<port>/ answers (any status < 500)
  	logDir: string;
  	now?: () => number;
  }
  export const HEALTH_TIMEOUT_MS = 30_000;
  export const STATUS_KEY = "preview";
  export class PreviewManager {
  	constructor(deps: PreviewDeps);
  	/** Resolves `preview` params against `sessionCwd` and runs the matching action. */
  	run(params: PreviewParams, sessionCwd: string, sessionId: string): Promise<ToolResult>;
  	current(): PreviewDetails | null;     // null when nothing runs (a dead dev server counts as nothing)
  	statusText(): string | undefined;      // `preview <label> :<port>` or undefined
  	stop(): Promise<void>;                 // kills the server, removes the serve entry, clears current
  	/** The scratch folder for this session's mockups: ~/.pi/agent/tmp/previews/<sessionId>/ (created). */
  	static mockupDir(home: string, sessionId: string): string;
  }
  export function defaultDeps(home: string): PreviewDeps;
  ```
  Behaviour pinned by tests:
  - `run({ cwd })`: `cwd` resolved against `sessionCwd`. No `package.json`, or no `scripts.dev` → `isError` with text `"<cwd> has no dev script; pass dir for a static folder or cwd of a Vite app."`. Otherwise: if `current()` is a `dev` preview for the same root and still listening → return the same result (text starts `Preview already open at`). Else stop any current, reconcile the range, pick the serve port, free local port, spawn, wait healthy (on timeout: kill, `isError`, text includes the last 20 log lines), `tailscale.add(port, local)`, record. `label` = `basename(root)`.
  - `run({ dir })` / `run({ file })`: root is the dir, or the file's folder; `startStatic(root)`; same exposure path; `kind: "static"`; `label` = basename of root, or the file name when `file` was given.
  - `run({})` with no cwd/dir/file/stop: creates `mockupDir` and returns text `"Mockup folder: <path>. Write index.html there, then call preview({ dir: \"<path>\" })."` with no `details` (nothing for the UI to render).
  - `run({ stop: true })`: `stop()`; text `"Preview stopped."`, details `{ stopped: true }`. With nothing running: same text, not an error.
  - Success text: `Preview open at <url> (<label>, <dev server|static folder> with live reload). Michael sees it in pi-web's Preview panel: tell him to take a look and ask what to change, then end your turn.`

- [ ] **Step 1: Write the failing tests**

Use a fake `Tailscale` (from Task 2's fake exec, with an in-memory `SERVE` that `add`/`remove` mutate), a fake `spawnDev` that starts a real `node:http` server on the requested port in-process and returns a `kill` that closes it, `waitHealthy` that polls with `fetch`, and `startStatic` from Task 3. Tests:

```ts
test("a Vite app gets a dev server, a serve entry in range and the result pi-web renders", async () => { /* package.json with dev script in a tmp cwd; run({cwd}); assert details = {url:`https://spark-713a.tail9274fa.ts.net:10600`, label: basename, kind:"dev", port:10600, root: cwd}; content[0].text matches /^Preview open at https:\/\/spark-713a\.tail9274fa\.ts\.net:10600 \(/; tailscale calls include add; env passed to spawnDev includes host */ });
test("the same cwd again returns the same url without a second server", async () => { /* two runs; spawn count 1; text starts "Preview already open at" */ });
test("a different cwd stops the first preview and takes one port", async () => { /* run A, run B; remove(10600) called before add; current().root === B; spawn count 2 */ });
test("a dead dev server is noticed and restarted; its serve entry is reconciled", async () => { /* run; kill the fake server out of band; seed SERVE with 10600 → dead local; run again → add(10600) after remove(10600) */ });
test("no dev script is an error and starts nothing", async () => { /* tmp dir without package.json; isError true; spawn count 0; tailscale add not called */ });
test("a static dir is served with live reload and labelled by its folder", async () => { /* run({dir}); kind static; fetch(url-equivalent local) ok; label basename */ });
test("file picks the folder and the file name", async () => { /* run({file: ".../mock.html"}); root is dirname; label "mock.html" */ });
test("stop removes the entry and clears current", async () => { /* run then run({stop:true}); details {stopped:true}; current() null; remove called; statusText undefined */ });
test("no arguments gives the mockup folder for the session", async () => { /* run({}, cwd, "sess-1"); text includes `previews/sess-1`; folder exists */ });
test("health timeout kills the server and reports the log tail", async () => { /* spawnDev that never listens; HEALTH_TIMEOUT overridden via deps.waitHealthy returning false; isError; kill called; no add */ });
```

Write each test body out in full in the file (the comments above are what each asserts).

- [ ] **Step 2: Run to verify failure** — `cd bridge && node --test --test-concurrency=1 test/preview.test.ts` → FAIL.

- [ ] **Step 3: Implement `bridge/preview.ts`**

`defaultDeps(home)` wires: `new Tailscale()`, `freeLocalPort`, `isListening`, `startStaticServer`, a `spawnDev` using `spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: host } })` with `child.unref()`, `kill` = `process.kill(-pid, "SIGTERM")` in a try/catch, log file `<logDir>/preview-<port>.log`; `waitHealthy` polling every 250 ms with `fetch` (any response, status < 500) until the timeout; `logDir` = `join(tmpdir(), "pi-preview", String(process.pid))`.

- [ ] **Step 4: Run to verify pass** — same command → PASS. Then `npm run typecheck -w bridge`.

- [ ] **Step 5: Commit**

```bash
git add bridge/preview.ts bridge/test/preview.test.ts
git commit -m "bridge: PreviewManager starts, exposes, reuses and stops one preview per session"
```

---

### Task 5: Register the tool, status key, shutdown, subagent refusal

**Files:**
- Modify: `bridge/index.ts`
- Modify: `bridge/pi-modules.d.ts` (only if `registerTool`'s typing needs a union for the two param shapes)
- Test: `bridge/test/preview-tool.test.ts`

**Interfaces:**
- Consumes: Task 4 `PreviewManager`, `defaultDeps`, `STATUS_KEY`.
- Produces: tool `preview` with schema
  ```ts
  Type.Object({
  	cwd: Type.Optional(Type.String({ description: "A Vite app checkout (has a dev script): start its dev server and show it" })),
  	dir: Type.Optional(Type.String({ description: "A folder of static files (an HTML mockup or prototype): serve it and show it" })),
  	file: Type.Optional(Type.String({ description: "One HTML file: serve its folder and show it" })),
  	stop: Type.Optional(Type.Boolean({ description: "Stop this session's preview server" })),
  })
  ```
  description: `Show Michael a live, clickable preview in pi-web's Preview panel (and in his phone's browser). Call it with cwd after the first visual change to an app and before any PR, then tell him to look and end your turn; the page live-reloads as you edit. Call it with dir or file for an HTML mockup or prototype (no arguments returns a scratch folder to write the mockup in). Tailnet only; one preview per session; it stops when the session ends.`

- [ ] **Step 1: Write the failing test**

Load `piWebBridge` with a fake `pi` capturing `registerTool` calls (like `bg/test/index.test.ts` does for bg) and assert: a tool named `preview` is registered before any `session_start` handler is needed; with `env.PI_SUBAGENT_CHILD = "1"` its `execute` returns `{ isError: true, content: [{ type: "text", text: "preview is not available in a subagent worker: ask the orchestrator to open the preview." }] }` and the injected manager's `run` is never called; without it `execute` forwards `params`, `ctx.cwd` and `ctx.sessionManager.getSessionId()` to `manager.run` and calls `ctx.ui.setStatus("preview", manager.statusText())` after; `session_shutdown` calls `manager.stop()` and `setStatus("preview", undefined)`. Give `piWebBridge` a second argument `opts: { preview?: PreviewManager; env?: NodeJS.ProcessEnv }` for injection (default: `new PreviewManager(defaultDeps(homedir()))`, `process.env`).

- [ ] **Step 2: Run to verify failure** — `cd bridge && node --test test/preview-tool.test.ts` → FAIL.

- [ ] **Step 3: Implement in `bridge/index.ts`**

Register `preview` right after `show_image` (before the `PI_WEB` early return, so the hub's headless children get it). Widen `PiApi.registerTool`'s `execute` param type to `any` params like bg does, and add `setStatus(key: string, text: string | undefined): void` to `CtxLike.ui` in `bridge/session.ts` (pi's ctx has it; bg already relies on it). Register `pi.on("session_shutdown", ...)` for the manager before the early return too (the existing `session_shutdown` handler for the bridge session stays where it is).

- [ ] **Step 4: Run all bridge tests and typecheck** — `npm run test -w bridge && npm run typecheck -w bridge` → PASS.

- [ ] **Step 5: Manual end-to-end on the spark** (not automated; record the outcome in the commit message)

Run `pi -p --model <pinned model per Michael's rule> "call preview with cwd ~/workspace/apps/fret and nothing else"` in a terminal pi with the bridge loaded, then: `tailscale serve status` shows `:10600 → 127.0.0.1:<local>`; `curl -sI https://spark-713a.tail9274fa.ts.net:10600/ | head -1` is `HTTP/2 200`; editing a CSS file in fret triggers HMR in a browser on the tailnet; ending the pi session removes the serve entry and the process.

- [ ] **Step 6: Commit**

```bash
git add bridge/index.ts bridge/pi-modules.d.ts bridge/test/preview-tool.test.ts
git commit -m "bridge: register the preview tool (status key preview, stops on shutdown, refused in workers)"
```

---

### Task 6: `bridge/skills/preview/SKILL.md`

**Files:**
- Create: `bridge/skills/preview/SKILL.md`

- [ ] **Step 1: Write the skill**

Frontmatter `name: preview`, `description: Use when you changed how a web app or page looks, or made an HTML mockup or prototype, and Michael should see it live before any PR; and when he asks to "show me", "let me see it" or "open the preview".` Body, in the show-image skill's style (≤ 40 lines): When (first visual change to an app; a mockup before code; before `pr`), How (1. `preview({ cwd })` for an app, `preview({ dir })` or `preview({ file })` for a mockup, `preview({})` first to get the scratch folder; 2. tell Michael in one line that the preview is open and end your turn; 3. edits live-reload, no need to call again; 4. `preview({ stop: true })` only when he says he is done or before switching apps), What Michael sees (desktop/iPad: the Preview tab beside the chat with fit/390/768 widths; phone: an Open button that opens his browser), Don't (don't screenshot the preview for him; don't open a PR before he has looked unless he waved it off; never pass a URL, the tool makes it).

- [ ] **Step 2: Check it loads** — `npm run test -w bridge` (the extension test loads the package's skills) → PASS.

- [ ] **Step 3: Commit**

```bash
git add bridge/skills/preview/SKILL.md
git commit -m "bridge: preview skill"
```

---

## Self-review notes

- Spec coverage: dev server (T4/T5), static mockups outside the repo (T4 `mockupDir`), stop (T4), port range + reconciliation + never outside range (T1/T2/T4), URL from `Self.DNSName` with the dot stripped (T2), Vite allowed hosts env (T4), health wait 30 s (T4), result shape for the UI (T4, consumed by plan 3 as `PreviewDetails`), status key `preview` not `bg-jobs` (T5), killed on `session_shutdown` which the hub's idle reaper triggers (T5), subagent refusal (T5), skill (T6).
- Not in this plan: the hub needs no change (events carry `details`; `hasBackgroundJobs` keys on `bg-jobs`, which the preview never sets).
