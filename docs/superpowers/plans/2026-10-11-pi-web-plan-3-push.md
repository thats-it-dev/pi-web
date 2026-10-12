# pi-web Plan 3: Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a headless session's run finishes while no app is watching, a dialog needs an answer, or a run ends in an error, the person's phone or desktop gets a notification. Tapping it opens the session.

**Architecture:** The hub makes VAPID keys once, keeps the list of subscribed browsers, and fans out encrypted Web Push messages (`hub/src/push.ts`). A small watcher (`hub/src/push-watch.ts`) listens to the registry's `session_state` changes and decides when a session deserves a push. The app's service worker shows the notification and routes the tap. The settings screen gets an on/off toggle that subscribes this device through the service worker and registers it with the hub.

**Tech Stack:** Node ≥ 22.18 running TypeScript by type stripping, `node:test`, and `web-push` 3.6.7. Only its pure `generateRequestDetails` and `generateVAPIDKeys` are used, and the hub sends with `fetch`. The app uses Lit and Vitest, and the service worker is plain JS.

**Spec:** `docs/superpowers/specs/2026-10-10-pi-web-design.md` (§2.1, §2.3 `/api/push/*` and `/api/health`, §5.5, §6, §7 "Push send fails", §8 manual checklist). Plans 1 and 2 are done and deployed: `docs/superpowers/plans/2026-10-10-pi-web-plan-1-hub-and-app.md` and `docs/superpowers/plans/2026-10-11-pi-web-plan-2-bridge.md`.

## Global Constraints

- Node ≥ 22.18. TypeScript runs by type stripping (`erasableSyntaxOnly`), so there are no parameter properties, enums or namespaces.
- Code style follows the repo: tabs, double quotes, `.ts` extensions in relative imports, and a short header comment saying what each file is for.
- The hub's only runtime dependency is `web-push`, pinned at exactly `3.6.7` (spec §2.1). `@types/web-push` is pinned at exactly `3.6.4`, as a hub devDependency. The app gains no dependency.
- Use only the repo's npm scripts. Never run `npx <tool>` for a tool that isn't already in `node_modules`.
- VAPID keys live in `<dataDir>/vapid.json` and subscriptions in `<dataDir>/push.json`. `<dataDir>` is `~/.config/pi-web` by default. Both files are mode `0600` and written atomically (write a temp file, then rename).
- The VAPID subject is `cfg.allowedOrigins[0]` (`https://pi.thatsit.app` by default).
- Push messages carry TTL `3600` seconds.
- The payload is exactly `{ sessionId, title, kind }`, with `kind` ∈ `"finished" | "needs_you" | "error"`, and nothing else. `title` is the session title the sidebar shows: the session name, else the first line of the first prompt, else the folder name, clipped to 60 characters.
- Triggers fire for **headless (`rpc`) sessions only**. Someone running a terminal session is at the terminal (Task 3 records this in spec §5.5).
- If the push service returns 404 or 410, the subscription is removed. Any other failure, including network errors and timeouts, is logged. Sending never throws and never blocks anything.
- Exact copy:
  - Notification body for `finished`: `Finished.`; for `needs_you`: `Needs you.`; for `error`: `Stopped with an error.`; for an unknown kind: `Something happened.`
  - Notification title fallback when the payload has none: `pi`
  - Settings heading: `notifications`
  - Settings hint: `Get a notification when a run finishes, needs you, or hits an error.`
  - Settings when no hub is set: `Connect to a hub first.`
  - Unsupported browser: `This browser can't receive push notifications.`
  - iOS outside the home-screen app: `On iPhone or iPad, add pi-web to the Home Screen first, then turn notifications on from there.`
  - Permission denied: `Notifications are blocked for this site. Allow them in the browser's settings.`
  - Hub without a key: `The hub has no push key. Update and restart the hub.`
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A subscription the push service has dropped** (an uninstalled PWA, a revoked permission). The service answers 404 or 410. Expect the subscription to be removed from `push.json` and never retried, while a 500, a refused connection or a timeout leaves it in place with only a log line. Pinned in Task 1.
2. **The app is open on the session when its run finishes.** Expect no "finished" push while a stream subscriber is attached, and one push when nobody is watching. Pinned in Task 3.
3. **An extension dialog while no run is going** (idle → needs_you → idle). Expect one "needs you" push and no "finished" push after it. Pinned in Task 3.
4. **The hub lost `push.json`, or regenerated its keys.** Expect the app to put its subscription back on the next load, re-subscribing silently when the hub's key changed, with no permission prompt. Pinned in Task 5.
5. **A corrupt `vapid.json` or `push.json`.** Expect the hub to start anyway and log what happened. A corrupt `vapid.json` gets new keys and clears the old subscriptions, since they are bound to the old key. Pinned in Task 1.

## File map

| File | Responsibility |
|---|---|
| `shared/src/protocol.ts` (modify) | `PushKind`, `PushPayload`, `PushSubscriptionInfo` |
| `hub/package.json` (modify) | `web-push` 3.6.7 and `@types/web-push` 3.6.4 |
| `hub/src/push.ts` (new) | `PushStore`: VAPID keys, the subscription list, fan-out with 404/410 cleanup |
| `hub/src/server.ts` (modify) | `/api/push/subscribe` and `/api/push/unsubscribe`, plus `vapidPublicKey` in `/api/health` |
| `hub/src/push-watch.ts` (new) | `watchPush()` decides when to push, and `sessionTitle()` |
| `hub/src/main.ts` (modify) | Builds the `PushStore`, passes it to the server, starts `watchPush` |
| `app/public/sw.js` (modify) | `push` and `notificationclick` handlers |
| `app/src/lib/push.ts` (new) | Status, enable, disable, resync and the service-worker message → route mapping |
| `app/src/lib/api.ts` (modify) | `pushSubscribe`, `pushUnsubscribe` |
| `app/src/components/pi-settings.ts` (modify) | The notifications toggle |
| `app/src/components/pi-app.ts`, `app/src/main.ts` (modify) | Resync on connect, and routing a notification tap |
| `README.md`, spec §5.5 (modify) | Push docs and the headless-only decision |

---

### Task 1: `PushStore`: keys, subscriptions and sending

**Files:**
- Modify: `shared/src/protocol.ts` (append the push types)
- Modify: `hub/package.json`, `package-lock.json` (via `npm install`)
- Create: `hub/src/push.ts`
- Test: `hub/test/push.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - From `shared/src/protocol.ts`: `type PushKind = "finished" | "needs_you" | "error"`, `interface PushPayload { sessionId: string; title: string; kind: PushKind }` and `interface PushSubscriptionInfo { endpoint: string; keys: { p256dh: string; auth: string } }`.
  - From `hub/src/push.ts`:
    - `isSubscription(x: unknown): x is PushSubscriptionInfo`
    - `class PushStore`, with `constructor(opts: { dataDir: string; subject: string; log?: (m: string) => void })`, `readonly publicKey: string`, `list(): PushSubscriptionInfo[]`, `subscribe(sub: PushSubscriptionInfo): void`, `unsubscribe(endpoint: string): void` and `send(payload: PushPayload): Promise<void>` (never rejects).

- [ ] **Step 1: Add the shared types**

Append to `shared/src/protocol.ts`:

```ts
// Web Push (spec §5.5). The payload names the session and why, and nothing more.
export type PushKind = "finished" | "needs_you" | "error";

export interface PushPayload {
	sessionId: string;
	title: string;
	kind: PushKind;
}

// A browser PushSubscription as JSON (PushSubscription.toJSON()).
export interface PushSubscriptionInfo {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}
```

- [ ] **Step 2: Add the dependency**

Run from the repo root:

```bash
npm install --save-exact -w hub web-push@3.6.7
npm install --save-exact --save-dev -w hub @types/web-push@3.6.4
```

`hub/package.json` should now contain `"dependencies": { "web-push": "3.6.7" }`, and its devDependencies should include `"@types/web-push": "3.6.4"`. Check that no other package was added to `hub/package.json`.

- [ ] **Step 3: Write the failing tests**

Create `hub/test/push.test.ts`:

```ts
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { PushSubscriptionInfo } from "../../shared/src/protocol.ts";
import { PushStore, isSubscription } from "../src/push.ts";

// A stand-in push service: answers each path with the status set for it, and records requests.
const statuses = new Map<string, number>();
const seen: Array<{ path: string; headers: IncomingMessage["headers"]; body: Buffer }> = [];
const service = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", () => {
		seen.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
		res.writeHead(statuses.get(req.url ?? "") ?? 201);
		res.end();
	});
});
let base = "";
before(async () => {
	await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
});
after(() => service.close());

function sub(path: string): PushSubscriptionInfo {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return { endpoint: `${base}${path}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

function store(dir = mkdtempSync(join(tmpdir(), "pi-web-push-"))) {
	const logs: string[] = [];
	return { dir, logs, push: new PushStore({ dataDir: dir, subject: "https://pi.thatsit.app", log: (m) => logs.push(m) }) };
}

test("keys are made once, kept private, and reused", () => {
	const { dir, push } = store();
	const file = join(dir, "vapid.json");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.match(push.publicKey, /^[A-Za-z0-9_-]{80,}$/);
	assert.equal(new PushStore({ dataDir: dir, subject: "https://x.test" }).publicKey, push.publicKey);
});

test("subscriptions are kept per endpoint and survive a restart", () => {
	const { dir, push } = store();
	const a = sub("/a");
	push.subscribe(a);
	push.subscribe({ ...a, keys: { ...a.keys } }); // the same browser again
	push.subscribe(sub("/b"));
	assert.deepEqual(push.list().map((s) => s.endpoint), [`${base}/a`, `${base}/b`]);
	assert.equal(statSync(join(dir, "push.json")).mode & 0o777, 0o600);
	const again = new PushStore({ dataDir: dir, subject: "https://pi.thatsit.app" });
	assert.equal(again.list().length, 2);
	again.unsubscribe(`${base}/a`);
	again.unsubscribe(`${base}/nope`);
	assert.deepEqual(new PushStore({ dataDir: dir, subject: "https://pi.thatsit.app" }).list().map((s) => s.endpoint), [`${base}/b`]);
});

test("send posts an encrypted, VAPID-signed message to every subscription", async () => {
	const { push } = store();
	push.subscribe(sub("/one"));
	push.subscribe(sub("/two"));
	seen.length = 0;
	await push.send({ sessionId: "s-1", title: "fix the parser", kind: "finished" });
	assert.deepEqual(seen.map((r) => r.path).sort(), ["/one", "/two"]);
	for (const r of seen) {
		assert.equal(r.headers["content-encoding"], "aes128gcm");
		assert.equal(r.headers.ttl, "3600");
		assert.match(String(r.headers.authorization), /^vapid t=.+, k=/);
		assert.ok(String(r.headers.authorization).includes(`k=${push.publicKey}`));
		assert.ok(r.body.length > 0);
		assert.ok(!r.body.toString("latin1").includes("fix the parser"), "the payload is encrypted");
	}
});

test("a 404 or 410 removes the subscription; other failures keep it and log", async () => {
	const { push, logs } = store();
	for (const p of ["/gone", "/missing", "/broken", "/fine"]) push.subscribe(sub(p));
	push.subscribe({ ...sub("/x"), endpoint: "http://127.0.0.1:1/closed" }); // nothing listens on port 1
	statuses.set("/gone", 410);
	statuses.set("/missing", 404);
	statuses.set("/broken", 500);
	await push.send({ sessionId: "s", title: "t", kind: "error" });
	assert.deepEqual(push.list().map((s) => s.endpoint).sort(), [`${base}/broken`, `${base}/fine`, "http://127.0.0.1:1/closed"].sort());
	assert.ok(logs.some((l) => l.includes("500")));
	assert.ok(logs.some((l) => l.includes("127.0.0.1:1")));
});

test("send with no subscriptions does nothing", async () => {
	const { push } = store();
	seen.length = 0;
	await push.send({ sessionId: "s", title: "t", kind: "needs_you" });
	assert.equal(seen.length, 0);
});

test("a corrupt push.json starts empty; a corrupt vapid.json gets new keys and drops old subscriptions", () => {
	const { dir, push } = store();
	push.subscribe(sub("/a"));
	const oldKey = push.publicKey;

	writeFileSync(join(dir, "push.json"), "{not json");
	const a = store(dir);
	assert.deepEqual(a.push.list(), []);
	assert.equal(a.push.publicKey, oldKey);
	assert.ok(a.logs.some((l) => l.includes("push.json")));

	a.push.subscribe(sub("/b"));
	writeFileSync(join(dir, "vapid.json"), "[]");
	const b = store(dir);
	assert.notEqual(b.push.publicKey, oldKey);
	assert.deepEqual(b.push.list(), []);
	assert.ok(b.logs.some((l) => l.includes("vapid.json")));
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "push.json"), "utf8")), []);
});

test("isSubscription accepts browser subscriptions and nothing else", () => {
	assert.equal(isSubscription(sub("/a")), true);
	assert.equal(isSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "p", auth: "a" }, expirationTime: null }), true);
	for (const bad of [null, "x", {}, { endpoint: "ftp://x", keys: { p256dh: "p", auth: "a" } }, { endpoint: "https://x", keys: { p256dh: "p" } }, { endpoint: "https://x" }]) {
		assert.equal(isSubscription(bad), false, JSON.stringify(bad));
	}
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `cd hub && node --test test/push.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/push.ts`.

- [ ] **Step 5: Implement `hub/src/push.ts`**

```ts
// Web Push for the hub (spec §5.5): VAPID keys made once, the browsers that
// subscribed, and fan-out. web-push builds the encrypted request; we send it.
// Sending never throws: a dead subscription (404/410) is dropped, anything
// else is logged.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import type { PushPayload, PushSubscriptionInfo } from "../../shared/src/protocol.ts";

const TTL_SECONDS = 3600; // a notification more than an hour late isn't worth showing
const SEND_TIMEOUT_MS = 10_000;

export interface PushStoreOptions {
	dataDir: string;
	subject: string; // VAPID contact: a mailto: or https: URL
	log?: (m: string) => void;
}

interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

export function isSubscription(x: unknown): x is PushSubscriptionInfo {
	const s = x as PushSubscriptionInfo | null;
	return !!s && typeof s === "object" && typeof s.endpoint === "string" && /^https?:\/\//.test(s.endpoint) && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";
}

export class PushStore {
	readonly publicKey: string;
	private privateKey: string;
	private subject: string;
	private file: string;
	private subs: PushSubscriptionInfo[];
	private log: (m: string) => void;

	constructor(opts: PushStoreOptions) {
		this.log = opts.log ?? ((m) => console.log(m));
		this.subject = opts.subject;
		this.file = join(opts.dataDir, "push.json");
		const { keys, fresh } = loadKeys(join(opts.dataDir, "vapid.json"), this.log);
		this.publicKey = keys.publicKey;
		this.privateKey = keys.privateKey;
		// Subscriptions are bound to the key they were made with, so new keys start an empty list.
		this.subs = fresh ? [] : loadSubs(this.file, this.log);
		if (fresh) this.save();
	}

	list(): PushSubscriptionInfo[] {
		return [...this.subs];
	}

	subscribe(sub: PushSubscriptionInfo): void {
		const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
		this.subs = [...this.subs.filter((s) => s.endpoint !== sub.endpoint), clean];
		this.save();
	}

	unsubscribe(endpoint: string): void {
		const next = this.subs.filter((s) => s.endpoint !== endpoint);
		if (next.length === this.subs.length) return;
		this.subs = next;
		this.save();
	}

	async send(payload: PushPayload): Promise<void> {
		const body = JSON.stringify(payload);
		await Promise.all(this.subs.map((s) => this.sendOne(s, body)));
	}

	private async sendOne(sub: PushSubscriptionInfo, payload: string): Promise<void> {
		const where = hostOf(sub.endpoint);
		try {
			const req = webpush.generateRequestDetails(sub, payload, {
				TTL: TTL_SECONDS,
				vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey },
			});
			// fetch sets Content-Length itself.
			const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== "content-length").map(([k, v]) => [k, String(v)]));
			const res = await fetch(req.endpoint, { method: req.method, headers, body: req.body ? new Uint8Array(req.body) : undefined, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
			if (res.status === 404 || res.status === 410) {
				this.log(`push: ${where} dropped a subscription (${res.status}); removed it`);
				this.unsubscribe(sub.endpoint);
				return;
			}
			if (!res.ok) this.log(`push: ${where} answered ${res.status}`);
		} catch (err) {
			this.log(`push: sending to ${where} failed: ${(err as Error).message}`);
		}
	}

	private save(): void {
		writeAtomic(this.file, `${JSON.stringify(this.subs, null, 2)}\n`);
	}
}

function loadKeys(file: string, log: (m: string) => void): { keys: VapidKeys; fresh: boolean } {
	if (existsSync(file)) {
		try {
			const k = JSON.parse(readFileSync(file, "utf8")) as VapidKeys;
			if (typeof k?.publicKey === "string" && typeof k.privateKey === "string") return { keys: k, fresh: false };
		} catch {}
		log(`push: ${file} was unreadable; made new keys, so every device must turn notifications on again`);
	}
	const { publicKey, privateKey } = webpush.generateVAPIDKeys();
	writeAtomic(file, `${JSON.stringify({ publicKey, privateKey }, null, 2)}\n`);
	return { keys: { publicKey, privateKey }, fresh: true };
}

function loadSubs(file: string, log: (m: string) => void): PushSubscriptionInfo[] {
	if (!existsSync(file)) return [];
	try {
		const list = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (Array.isArray(list)) return list.filter(isSubscription);
	} catch {}
	log(`push: ${file} was unreadable; starting with no subscriptions`);
	return [];
}

function writeAtomic(file: string, text: string): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, file);
}

function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return "?";
	}
}
```

If `@types/web-push` types `req.headers` or `req.body` differently from what this code assumes, adapt only the conversions on those two lines (`String(v)`, `new Uint8Array(...)`). The behavior must stay the same. Say so in your report.

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd hub && node --test test/push.test.ts && npm run typecheck -w hub`
Expected: all 7 tests PASS, and the typecheck is clean.

- [ ] **Step 7: Run the hub suite, then commit**

Run: `npm test -w hub`
Expected: PASS.

```bash
git add shared/src/protocol.ts hub/package.json package-lock.json hub/src/push.ts hub/test/push.test.ts
git commit -m "feat(hub): PushStore: VAPID keys, subscriptions, and Web Push fan-out

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Push routes and the public key in `/api/health`

**Files:**
- Modify: `hub/src/server.ts` (the `HubDeps` interface, the `/api/health` route, and two new routes)
- Test: `hub/test/push-routes.test.ts`

**Interfaces:**
- Consumes: `PushStore` and `isSubscription` from Task 1.
- Produces:
  - `HubDeps.push?: PushStore`, an optional dependency of `createHubServer`.
  - `POST /api/push/subscribe`, which takes a `PushSubscriptionInfo` body and returns `{ ok: true }`. It answers 400 for a bad body and 503 when there's no push store.
  - `POST /api/push/unsubscribe`, which takes `{ endpoint: string }` and returns `{ ok: true }`. It answers 400 when `endpoint` is missing and 503 when there's no push store.
  - `GET /api/health` returns `vapidPublicKey: push.publicKey`, or `null` when there's no push store.

- [ ] **Step 1: Write the failing tests**

Create `hub/test/push-routes.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { HubConfig } from "../src/config.ts";
import { PushStore } from "../src/push.ts";
import { Registry } from "../src/registry.ts";
import { createHubServer } from "../src/server.ts";
import { SessionIndex } from "../src/sessions.ts";
import { call } from "./support/http.ts";

const root = mkdtempSync(join(tmpdir(), "pi-web-push-routes-"));
mkdirSync(join(root, "sessions"));
const cfg: HubConfig = {
	port: 0,
	hostname: "hub.test:7878",
	allowedLogin: "me@github",
	allowedOrigins: ["https://pi.thatsit.app"],
	idleMinutes: 20,
	maxHeadless: 6,
	piBin: "pi",
	dev: false,
	dataDir: root,
};
const GOOD = { origin: "https://pi.thatsit.app", host: "hub.test:7878", "tailscale-user-login": "me@github" };
const index = new SessionIndex(join(root, "sessions"));
const registry = new Registry({ factory: { startRpc: () => Promise.reject(new Error("no pi in this test")) }, lookup: index, maxHeadless: 1, idleMs: 60_000 });
const push = new PushStore({ dataDir: root, subject: "https://pi.thatsit.app", log: () => {} });
const withPush = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: root, push, log: () => {} });
const without = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: root, log: () => {} });
let port = 0;
let bare = 0;
before(async () => {
	await new Promise<void>((r) => withPush.listen(0, "127.0.0.1", r));
	await new Promise<void>((r) => without.listen(0, "127.0.0.1", r));
	port = (withPush.address() as AddressInfo).port;
	bare = (without.address() as AddressInfo).port;
});
after(() => {
	withPush.close();
	without.close();
});

const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", expirationTime: null, keys: { p256dh: "BPub", auth: "secret" } };

test("health carries the VAPID public key", async () => {
	const r = await call(port, "GET", "/api/health", GOOD);
	assert.equal(r.status, 200);
	assert.equal(r.body.vapidPublicKey, push.publicKey);
	assert.equal((await call(bare, "GET", "/api/health", GOOD)).body.vapidPublicKey, null);
});

test("subscribe stores the browser; unsubscribe removes it", async () => {
	const r = await call(port, "POST", "/api/push/subscribe", GOOD, SUB);
	assert.deepEqual([r.status, r.body], [200, { ok: true }]);
	assert.deepEqual(push.list(), [{ endpoint: SUB.endpoint, keys: SUB.keys }]);
	const u = await call(port, "POST", "/api/push/unsubscribe", GOOD, { endpoint: SUB.endpoint });
	assert.deepEqual([u.status, u.body], [200, { ok: true }]);
	assert.deepEqual(push.list(), []);
});

test("bad bodies are refused", async () => {
	assert.equal((await call(port, "POST", "/api/push/subscribe", GOOD, { endpoint: "https://x" })).status, 400);
	assert.equal((await call(port, "POST", "/api/push/unsubscribe", GOOD, {})).status, 400);
	assert.deepEqual(push.list(), []);
});

test("push routes need the same identity as everything else", async () => {
	assert.equal((await call(port, "POST", "/api/push/subscribe", { ...GOOD, origin: "https://evil.example" }, SUB)).status, 403);
	assert.equal((await call(port, "POST", "/api/push/subscribe", { ...GOOD, "tailscale-user-login": undefined }, SUB)).status, 403);
	assert.deepEqual(push.list(), []);
});

test("a hub without push says so", async () => {
	assert.equal((await call(bare, "POST", "/api/push/subscribe", GOOD, SUB)).status, 503);
	assert.equal((await call(bare, "POST", "/api/push/unsubscribe", GOOD, { endpoint: SUB.endpoint })).status, 503);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hub && node --test test/push-routes.test.ts`
Expected: FAIL. The health key is `null`, and the push routes return 404.

- [ ] **Step 3: Implement the routes**

In `hub/src/server.ts`:

- Add an import: `import { type PushStore, isSubscription } from "./push.ts";`
- Add `push?: PushStore;` to `HubDeps`, after `log?`.
- In the `/api/health` route, replace `vapidPublicKey: null` with `vapidPublicKey: deps.push?.publicKey ?? null`.
- After the `POST /api/sessions` block, and before the `const sm = p.match(...)` line, add:

```ts
		if (m === "POST" && (p === "/api/push/subscribe" || p === "/api/push/unsubscribe")) {
			if (!deps.push) throw new HttpError(503, "Push isn't set up on this hub");
			const body = await readJson(req);
			if (p === "/api/push/subscribe") {
				if (!isSubscription(body)) throw new HttpError(400, "Not a push subscription");
				deps.push.subscribe(body);
			} else {
				const endpoint = (body as { endpoint?: unknown }).endpoint;
				if (typeof endpoint !== "string") throw new HttpError(400, "An endpoint is required");
				deps.push.unsubscribe(endpoint);
			}
			return sendJson(res, 200, { ok: true }, cors);
		}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hub && node --test test/push-routes.test.ts && npm run typecheck -w hub`
Expected: 5 tests PASS, and the typecheck is clean.

- [ ] **Step 5: Run the hub suite, then commit**

Run: `npm test -w hub`
Expected: PASS. The existing `server.test.ts` builds its server without `push`, so it keeps working unchanged.

```bash
git add hub/src/server.ts hub/test/push-routes.test.ts
git commit -m "feat(hub): /api/push/subscribe and /unsubscribe; health carries the VAPID key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: When to push, wired into the hub

**Files:**
- Create: `hub/src/push-watch.ts`
- Test: `hub/test/push-watch.test.ts`
- Modify: `hub/src/main.ts`
- Modify: `docs/superpowers/specs/2026-10-10-pi-web-design.md` §5.5

**Interfaces:**
- Consumes:
  - `PushStore` (Task 1), and `PushPayload` and `PushKind` (Task 1, from `shared/src/protocol.ts`).
  - `Registry.onChange` and `Registry.get` (Plan 1). `onChange` emits `{ type: "session_state", sessionId, live, handleKind, state }` whenever a session's live state may have changed, sometimes repeating the same state.
  - `contentText` from `shared/src/reducer.ts`.
  - `FakeHandle` from `hub/test/support/fake-handle.ts`. It has public `state`, `busy`, `conv`, `subscribe()` and `fire()`.
- Produces:
  - `watchPush(registry: Pick<Registry, "onChange" | "get">, send: (p: PushPayload) => void): () => void`. The returned function stops watching.
  - `sessionTitle(snap: Snapshot): string`.

The rules, per session (headless only):
- **needs_you:** sent each time the state becomes `needs_you`.
- **A run** starts when the state first becomes `running`. The watcher then remembers the conversation's last message. The run ends when the state returns to `idle`. A `needs_you` in the middle of a run doesn't end it.
- **At the end of a run**, look at the conversation's last message:
  - If it is the same message object remembered at the start, or not an assistant message, send nothing.
  - If its `stopReason` is `"error"`, send `error`, even when someone is watching.
  - If its `stopReason` is `"aborted"`, send nothing, because the person stopped it.
  - Otherwise send `finished`, but only when `subscriberCount() === 0`.
- Terminal (`bridge`) sessions and sessions that are no longer live are never pushed, and their tracking is dropped.

- [ ] **Step 1: Write the failing tests**

Create `hub/test/push-watch.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, LiveState, PushPayload } from "../../shared/src/protocol.ts";
import { watchPush } from "../src/push-watch.ts";
import { Registry } from "../src/registry.ts";
import { FakeHandle } from "./support/fake-handle.ts";

function setup() {
	let n = 0;
	const registry = new Registry({
		factory: { startRpc: async (o) => new FakeHandle(`s-${++n}`, o.cwd) },
		lookup: { find: async () => null },
		maxHeadless: 6,
		idleMs: 60_000,
	});
	const sent: PushPayload[] = [];
	const stop = watchPush(registry, (p) => sent.push(p));
	return { registry, sent, stop };
}

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }] });
const reply = (stopReason = "stop"): AgentMessage => ({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason });

function to(h: FakeHandle, state: LiveState): void {
	h.state = state;
	h.busy = state !== "idle";
	h.fire({ type: "state_changed" });
}

async function run(h: FakeHandle, end: AgentMessage = reply()): Promise<void> {
	to(h, "running");
	h.conv.messages.push(user("fix the parser\nand the tests"), end);
	to(h, "idle");
}

test("a run that finishes with nobody watching sends 'finished', titled by the first prompt line", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	await run(h);
	assert.deepEqual(sent, [{ sessionId: "s-1", title: "fix the parser", kind: "finished" }]);
});

test("no 'finished' while an app stream is attached", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	const off = h.subscribe(() => {});
	await run(h);
	assert.deepEqual(sent, []);
	off();
});

test("a run that ends in an error sends 'error' even while watched; an aborted run sends nothing", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	const off = h.subscribe(() => {});
	await run(h, reply("error"));
	assert.deepEqual(sent.map((p) => p.kind), ["error"]);
	off();
	await run(h, reply("aborted"));
	assert.deepEqual(sent.map((p) => p.kind), ["error"]);
});

test("a dialog during a run sends 'needs_you', and the run still reports when it ends", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	to(h, "running");
	to(h, "needs_you");
	to(h, "running");
	h.conv.messages.push(user("go"), reply());
	to(h, "idle");
	assert.deepEqual(sent.map((p) => p.kind), ["needs_you", "finished"]);
});

test("a dialog while idle sends 'needs_you' once and no 'finished'", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	to(h, "needs_you");
	h.fire({ type: "state_changed" }); // the same state reported again
	to(h, "idle");
	assert.deepEqual(sent.map((p) => p.kind), ["needs_you"]);
});

test("a run that adds no new assistant message (a manual compaction) sends nothing", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	h.conv.messages.push(user("earlier"), reply());
	to(h, "running");
	to(h, "idle");
	assert.deepEqual(sent, []);
});

test("terminal sessions never push", async () => {
	const { registry, sent } = setup();
	const t = new FakeHandle("term-1", "/work/proj", null, { kind: "bridge", pid: 999 });
	assert.equal(registry.attachBridge(t), "attached");
	await run(t);
	to(t, "needs_you");
	assert.deepEqual(sent, []);
});

test("the title prefers the session name, falls back to the folder, and is clipped", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	to(h, "needs_you");
	assert.equal(sent.at(-1)?.title, "proj");
	const snap = h.snapshot.bind(h);
	h.snapshot = () => ({ ...snap(), state: { ...snap().state, sessionName: "x".repeat(80) } });
	to(h, "idle");
	to(h, "needs_you");
	assert.equal(sent.at(-1)?.title, `${"x".repeat(59)}…`);
});

test("stop() ends watching", async () => {
	const { registry, sent, stop } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	stop();
	to(h, "needs_you");
	assert.deepEqual(sent, []);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hub && node --test test/push-watch.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/push-watch.ts`.

- [ ] **Step 3: Implement `hub/src/push-watch.ts`**

```ts
// Decides when a session deserves a push (spec §5.5): a run finished while no
// app was watching, a dialog is waiting, or a run ended in an error. Headless
// sessions only: someone running a terminal session is at the terminal.

import { basename } from "node:path";
import type { AgentMessage, LiveState, PushKind, PushPayload, Snapshot } from "../../shared/src/protocol.ts";
import { contentText } from "../../shared/src/reducer.ts";
import type { Registry } from "./registry.ts";

const TITLE_MAX = 60;

interface Track {
	state: LiveState;
	running: boolean;
	lastBefore: AgentMessage | undefined; // the conversation's last message when the run started
}

export function watchPush(registry: Pick<Registry, "onChange" | "get">, send: (p: PushPayload) => void): () => void {
	const tracks = new Map<string, Track>();
	return registry.onChange((m) => {
		if (m.type !== "session_state") return;
		const h = registry.get(m.sessionId);
		if (!m.live || !h || h.kind !== "rpc") {
			tracks.delete(m.sessionId);
			return;
		}
		let t = tracks.get(m.sessionId);
		if (!t) {
			t = { state: "idle", running: false, lastBefore: undefined };
			tracks.set(m.sessionId, t);
		}
		if (m.state === t.state) return;
		t.state = m.state;
		const snap = h.snapshot();
		const push = (kind: PushKind) => send({ sessionId: m.sessionId, title: sessionTitle(snap), kind });

		if (m.state === "running" && !t.running) {
			t.running = true;
			t.lastBefore = snap.conv.messages.at(-1);
		}
		if (m.state === "needs_you") push("needs_you");
		if (m.state === "idle" && t.running) {
			t.running = false;
			const last = snap.conv.messages.at(-1);
			if (!last || last === t.lastBefore || last.role !== "assistant") return;
			if (last.stopReason === "error") push("error");
			else if (last.stopReason !== "aborted" && h.subscriberCount() === 0) push("finished");
		}
	});
}

// What the sidebar calls the session: its name, else the first prompt's first line, else its folder.
export function sessionTitle(snap: Snapshot): string {
	const name = snap.state?.sessionName?.trim();
	if (name) return clip(name);
	const first = snap.conv.messages.find((m) => m.role === "user");
	const line = first ? (contentText(first.content).trim().split("\n")[0] ?? "") : "";
	return clip(line.trim() || basename(snap.cwd) || "pi");
}

function clip(s: string): string {
	return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hub && node --test test/push-watch.test.ts && npm run typecheck -w hub`
Expected: 9 tests PASS, and the typecheck is clean.

- [ ] **Step 5: Wire push into `hub/src/main.ts`**

- Add the imports `import { PushStore } from "./push.ts";` and `import { watchPush } from "./push-watch.ts";`.
- After `setInterval(() => registry.reap(), 60_000).unref();`, add:

```ts
const push = new PushStore({ dataDir: cfg.dataDir, subject: cfg.allowedOrigins[0] ?? "https://pi.thatsit.app" });
watchPush(registry, (p) => void push.send(p));
```

- Change `createHubServer({ cfg, registry, index, version })` to `createHubServer({ cfg, registry, index, version, push })`.

- [ ] **Step 6: Smoke-test the hub start**

Run:

```bash
D=$(mktemp -d) && printf '{"hostname":"hub.test:7878","allowedLogin":"me@github","port":7979}\n' > $D/config.json && (cd hub && PI_WEB_DATA_DIR=$D timeout 3 node src/main.ts; true) && ls -l $D && cat $D/push.json
```

Expected: the hub logs its start line. Then `vapid.json` and `push.json` are listed with mode `-rw-------`, and `push.json` contains `[]`.

- [ ] **Step 7: Record the headless-only rule in the spec**

In `docs/superpowers/specs/2026-10-10-pi-web-design.md` §5.5, replace the `- Triggers:` bullet and its three sub-bullets with:

```markdown
- Triggers, for headless (RpcHandle) sessions only, since someone running a terminal session is at the terminal:
  - a run ends with a new assistant message and no stream subscriber is attached to that session ("finished"). A run the person aborted sends nothing.
  - the session starts waiting on a dialog ("needs you")
  - a run's final assistant `stopReason` is `"error"` ("error"), whether or not anyone is watching
```

- [ ] **Step 8: Run the hub suite, then commit**

Run: `npm test -w hub && npm run typecheck -w hub`
Expected: PASS.

```bash
git add hub/src/push-watch.ts hub/test/push-watch.test.ts hub/src/main.ts docs/superpowers/specs/2026-10-10-pi-web-design.md
git commit -m "feat(hub): push when a headless run finishes unwatched, needs you, or errors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The service worker shows notifications and routes taps

**Files:**
- Modify: `app/public/sw.js` (append two handlers)
- Test: `app/src/sw.test.ts`

**Interfaces:**
- Consumes: the `PushPayload` shape (Task 1): `{ sessionId, title, kind }`.
- Produces:
  - The service worker shows each push as a notification. Its `tag` is the `sessionId`, so a newer push for a session replaces the older one, and `data` is `{ sessionId }`.
  - On a tap with an app window open, the service worker posts `{ type: "pi-open", sessionId }` to that window and focuses it. With no window open, it opens `/#/s/<encoded sessionId>`. Task 5's `openHashFromMessage` consumes the message.

- [ ] **Step 1: Write the failing tests**

Create `app/src/sw.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";

// Runs public/sw.js against a fake service-worker global and returns its handlers.
function loadWorker(windows: Array<{ postMessage: (m: unknown) => void; focus: () => Promise<unknown> }> = []) {
	const handlers: Record<string, (e: any) => void> = {};
	const self = {
		addEventListener: (type: string, fn: (e: any) => void) => (handlers[type] = fn),
		registration: { showNotification: vi.fn(async (_title: string, _opts: any) => {}) },
		clients: { matchAll: vi.fn(async (_o?: unknown) => windows), openWindow: vi.fn(async (_url: string) => null), claim: vi.fn() },
		location: { origin: "https://pi.thatsit.app" },
		skipWaiting: vi.fn(),
	};
	const src = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
	new Function("self", "caches", "fetch", src)(self, {}, vi.fn());
	return { handlers, self };
}

async function dispatch(handler: (e: any) => void, event: Record<string, unknown>): Promise<void> {
	let done: Promise<unknown> = Promise.resolve();
	handler({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) });
	await done;
}

test("a push shows a notification named for the session", async () => {
	const { handlers, self } = loadWorker();
	await dispatch(handlers.push, { data: { json: () => ({ sessionId: "s-1", title: "fix the parser", kind: "needs_you" }) } });
	expect(self.registration.showNotification).toHaveBeenCalledWith("fix the parser", {
		body: "Needs you.",
		tag: "s-1",
		data: { sessionId: "s-1" },
		icon: "/icons/icon-192.png",
	});
});

test("each kind has its own text, and a bad payload still shows something", async () => {
	const { handlers, self } = loadWorker();
	const show = self.registration.showNotification;
	await dispatch(handlers.push, { data: { json: () => ({ sessionId: "a", title: "t", kind: "finished" }) } });
	await dispatch(handlers.push, { data: { json: () => ({ sessionId: "a", title: "t", kind: "error" }) } });
	await dispatch(handlers.push, { data: { json: () => ({ sessionId: "a", title: "t", kind: "toString" }) } });
	await dispatch(handlers.push, {
		data: {
			json: () => {
				throw new SyntaxError("bad");
			},
		},
	});
	await dispatch(handlers.push, { data: null });
	expect(show.mock.calls.map((c) => c[1].body)).toEqual(["Finished.", "Stopped with an error.", "Something happened.", "Something happened.", "Something happened."]);
	expect(show.mock.calls.at(-1)?.[0]).toBe("pi");
	expect(show.mock.calls.at(-1)?.[1].tag).toBe("pi-web");
});

test("tapping a notification with the app open routes that window to the session", async () => {
	const win = { postMessage: vi.fn(), focus: vi.fn(async () => win) };
	const { handlers, self } = loadWorker([win]);
	const notification = { close: vi.fn(), data: { sessionId: "s/1" } };
	await dispatch(handlers.notificationclick, { notification });
	expect(notification.close).toHaveBeenCalled();
	expect(win.postMessage).toHaveBeenCalledWith({ type: "pi-open", sessionId: "s/1" });
	expect(win.focus).toHaveBeenCalled();
	expect(self.clients.openWindow).not.toHaveBeenCalled();
});

test("tapping a notification with the app closed opens the session", async () => {
	const { handlers, self } = loadWorker([]);
	await dispatch(handlers.notificationclick, { notification: { close: vi.fn(), data: { sessionId: "s/1" } } });
	expect(self.clients.openWindow).toHaveBeenCalledWith("/#/s/s%2F1");
	await dispatch(handlers.notificationclick, { notification: { close: vi.fn(), data: null } });
	expect(self.clients.openWindow).toHaveBeenLastCalledWith("/");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -w app -- src/sw.test.ts`
Expected: FAIL. `handlers.push` is undefined.

- [ ] **Step 3: Add the handlers**

Append to `app/public/sw.js`:

```js

// Push (spec §5.5). The payload is { sessionId, title, kind } and nothing else.
const PUSH_BODY = { finished: "Finished.", needs_you: "Needs you.", error: "Stopped with an error." };

self.addEventListener("push", (event) => {
	let p = {};
	try {
		p = (event.data && event.data.json()) || {};
	} catch {}
	const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
	const title = typeof p.title === "string" && p.title ? p.title : "pi";
	const body = typeof p.kind === "string" && Object.hasOwn(PUSH_BODY, p.kind) ? PUSH_BODY[p.kind] : "Something happened.";
	event.waitUntil(self.registration.showNotification(title, { body, tag: sessionId || "pi-web", data: { sessionId }, icon: "/icons/icon-192.png" }));
});

// A tap opens the session: an open window is told where to go (and focused), else a new one opens there.
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const sessionId = (event.notification.data && event.notification.data.sessionId) || "";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
			const win = wins[0];
			if (!win) return self.clients.openWindow(sessionId ? `/#/s/${encodeURIComponent(sessionId)}` : "/");
			if (sessionId) win.postMessage({ type: "pi-open", sessionId });
			return win.focus();
		}),
	);
});
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm test -w app -- src/sw.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Run the app suite, then commit**

Run: `npm test -w app && npm run typecheck -w app`
Expected: PASS.

```bash
git add app/public/sw.js app/src/sw.test.ts
git commit -m "feat(app): service worker shows push notifications and opens the session on tap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The settings toggle, keeping the hub in step, and docs

**Files:**
- Create: `app/src/lib/push.ts`, `app/src/lib/push.test.ts`
- Modify: `app/src/lib/api.ts` (two methods)
- Modify: `app/src/components/pi-settings.ts` (the notifications section)
- Modify: `app/src/components/pi-app.ts` (resync on connect)
- Modify: `app/src/main.ts` (route a notification tap)
- Modify: `README.md`

**Interfaces:**
- Consumes:
  - `PushSubscriptionInfo` (Task 1).
  - `/api/push/subscribe`, `/api/push/unsubscribe`, and `vapidPublicKey` in `/api/health` (Task 2).
  - The `{ type: "pi-open", sessionId }` message from the service worker (Task 4).
  - `hrefFor` from `app/src/lib/route.ts`.
- Produces:
  - `HubApi.pushSubscribe(sub: PushSubscriptionInfo)` and `HubApi.pushUnsubscribe(endpoint: string)`.
  - From `app/src/lib/push.ts`:
    - `type PushStatus = "unsupported" | "install-first" | "denied" | "off" | "on"`
    - `PUSH_COPY`
    - `interface PushEnv`, `interface PushManagerLike`, `interface PushSubLike`
    - `base64UrlToBytes(s: string): Uint8Array`
    - `pushStatus(env: PushEnv): Promise<PushStatus>`
    - `enablePush(api: PushApi, env: PushEnv): Promise<void>`, which throws an `Error` with `PUSH_COPY` text
    - `disablePush(api: PushApi, env: PushEnv): Promise<void>`
    - `resyncPush(api: PushApi, env: PushEnv): Promise<void>`, which never rejects
    - `openHashFromMessage(data: unknown): string | null`
    - `browserPushEnv(): PushEnv`

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/push.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { PUSH_COPY, type PushEnv, type PushManagerLike, type PushSubLike, base64UrlToBytes, disablePush, enablePush, openHashFromMessage, pushStatus, resyncPush } from "./push.ts";

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const OTHER = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";

function sub(key: string, endpoint = "https://push.example/1"): PushSubLike & { unsubscribe: ReturnType<typeof vi.fn> } {
	return {
		endpoint,
		options: { applicationServerKey: base64UrlToBytes(key).buffer as ArrayBuffer },
		toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
		unsubscribe: vi.fn(async () => true),
	};
}

function env(over: Partial<PushEnv> = {}, current: PushSubLike | null = null) {
	const pm: PushManagerLike & { current: PushSubLike | null } = {
		current,
		getSubscription: vi.fn(async () => pm.current),
		subscribe: vi.fn(async (o: { applicationServerKey: Uint8Array }) => {
			pm.current = sub(btoa(String.fromCharCode(...o.applicationServerKey)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "https://push.example/new");
			return pm.current;
		}),
	};
	const e: PushEnv = {
		pushManager: async () => pm,
		permission: () => "granted",
		requestPermission: vi.fn(async () => "granted" as NotificationPermission),
		ios: false,
		standalone: false,
		...over,
	};
	return { e, pm };
}

function api(key: string | null = KEY) {
	return {
		health: vi.fn(async () => ({ ok: true as const, login: "me", hubVersion: "0.1.0", vapidPublicKey: key })),
		pushSubscribe: vi.fn(async () => ({ ok: true as const })),
		pushUnsubscribe: vi.fn(async () => ({ ok: true as const })),
	};
}

test("base64UrlToBytes decodes a VAPID key to its 65 raw bytes", () => {
	const b = base64UrlToBytes(KEY);
	expect(b.length).toBe(65);
	expect(b[0]).toBe(4);
});

test("status covers iOS outside the home screen, no support, denied, off and on", async () => {
	expect(await pushStatus(env({ ios: true, standalone: false }).e)).toBe("install-first");
	expect(await pushStatus(env({ pushManager: async () => null }).e)).toBe("unsupported");
	expect(await pushStatus(env({ permission: () => "denied" }).e)).toBe("denied");
	expect(await pushStatus(env().e)).toBe("off");
	expect(await pushStatus(env({ ios: true, standalone: true }, sub(KEY)).e)).toBe("on");
});

test("enable asks permission, subscribes with the hub's key and registers with the hub", async () => {
	const { e, pm } = env();
	const a = api();
	await enablePush(a, e);
	expect(e.requestPermission).toHaveBeenCalled();
	expect(pm.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(KEY) });
	expect(a.pushSubscribe).toHaveBeenCalledWith({ endpoint: "https://push.example/new", keys: { p256dh: "p", auth: "a" } });
});

test("enable reuses a subscription made with the same key, and replaces one made with another", async () => {
	const same = env({}, sub(KEY));
	await enablePush(api(), same.e);
	expect(same.pm.subscribe).not.toHaveBeenCalled();

	const old = sub(OTHER);
	const other = env({}, old);
	await enablePush(api(), other.e);
	expect(old.unsubscribe).toHaveBeenCalled();
	expect(other.pm.subscribe).toHaveBeenCalled();
});

test("enable explains what stops it", async () => {
	await expect(enablePush(api(null), env().e)).rejects.toThrow(PUSH_COPY.noKey);
	await expect(enablePush(api(), env({ requestPermission: async () => "denied" }).e)).rejects.toThrow(PUSH_COPY.denied);
	await expect(enablePush(api(), env({ pushManager: async () => null }).e)).rejects.toThrow(PUSH_COPY.unsupported);
});

test("disable tells the hub and unsubscribes, even when the hub can't be reached", async () => {
	const s = sub(KEY);
	const a = api();
	await disablePush(a, env({}, s).e);
	expect(a.pushUnsubscribe).toHaveBeenCalledWith("https://push.example/1");
	expect(s.unsubscribe).toHaveBeenCalled();

	const s2 = sub(KEY);
	const down = { ...api(), pushUnsubscribe: vi.fn(async () => Promise.reject(new Error("offline"))) };
	await disablePush(down, env({}, s2).e);
	expect(s2.unsubscribe).toHaveBeenCalled();
	await disablePush(api(), env().e); // nothing subscribed: nothing to do
});

test("resync puts this device back on the hub only when it is on, and never throws", async () => {
	const a = api();
	await resyncPush(a, env({}, sub(KEY)).e);
	expect(a.pushSubscribe).toHaveBeenCalledTimes(1);

	const off = api();
	await resyncPush(off, env().e);
	expect(off.pushSubscribe).not.toHaveBeenCalled();

	const rotated = env({}, sub(OTHER));
	await resyncPush(api(), rotated.e); // the hub has new keys: re-subscribe without asking
	expect(rotated.pm.subscribe).toHaveBeenCalled();

	await expect(resyncPush({ ...api(), health: async () => Promise.reject(new Error("down")) }, env({}, sub(KEY)).e)).resolves.toBeUndefined();
});

test("a service-worker message routes to the session", () => {
	expect(openHashFromMessage({ type: "pi-open", sessionId: "s/1" })).toBe("#/s/s%2F1");
	expect(openHashFromMessage({ type: "pi-open" })).toBeNull();
	expect(openHashFromMessage({ type: "other", sessionId: "x" })).toBeNull();
	expect(openHashFromMessage(null)).toBeNull();
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -w app -- src/lib/push.test.ts`
Expected: FAIL. `./push.ts` is missing.

- [ ] **Step 3: Add the API methods**

In `app/src/lib/api.ts`, add `PushSubscriptionInfo` to the `import type` from `protocol.ts`, and add these methods after `close(id)`:

```ts
	pushSubscribe(sub: PushSubscriptionInfo) {
		return this.req<{ ok: true }>("POST", "/api/push/subscribe", sub);
	}
	pushUnsubscribe(endpoint: string) {
		return this.req<{ ok: true }>("POST", "/api/push/unsubscribe", { endpoint });
	}
```

- [ ] **Step 4: Implement `app/src/lib/push.ts`**

```ts
// Push notifications on this device (spec §5.5): subscribe through the service
// worker with the hub's VAPID key, register the subscription with the hub, and
// keep the two in step when the hub forgets it or changes keys.

import type { HealthInfo, PushSubscriptionInfo } from "../../../shared/src/protocol.ts";
import { hrefFor } from "./route.ts";

export type PushStatus = "unsupported" | "install-first" | "denied" | "off" | "on";

export const PUSH_COPY = {
	hint: "Get a notification when a run finishes, needs you, or hits an error.",
	noHub: "Connect to a hub first.",
	unsupported: "This browser can't receive push notifications.",
	installFirst: "On iPhone or iPad, add pi-web to the Home Screen first, then turn notifications on from there.",
	denied: "Notifications are blocked for this site. Allow them in the browser's settings.",
	noKey: "The hub has no push key. Update and restart the hub.",
} as const;

export interface PushSubLike {
	endpoint: string;
	options?: { applicationServerKey?: ArrayBuffer | null };
	toJSON(): { endpoint?: string; keys?: Record<string, string> };
	unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
	getSubscription(): Promise<PushSubLike | null>;
	subscribe(o: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<PushSubLike>;
}

export interface PushEnv {
	pushManager(): Promise<PushManagerLike | null>; // null: no service worker or no Push API here
	permission(): NotificationPermission | "unsupported";
	requestPermission(): Promise<NotificationPermission>;
	ios: boolean;
	standalone: boolean; // running as the installed home-screen app
}

export interface PushApi {
	health(): Promise<HealthInfo>;
	pushSubscribe(sub: PushSubscriptionInfo): Promise<{ ok: true }>;
	pushUnsubscribe(endpoint: string): Promise<{ ok: true }>;
}

export function base64UrlToBytes(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function pushStatus(env: PushEnv): Promise<PushStatus> {
	if (env.ios && !env.standalone) return "install-first";
	const pm = await env.pushManager();
	if (!pm) return "unsupported";
	if (env.permission() === "denied") return "denied";
	return (await pm.getSubscription()) ? "on" : "off";
}

export async function enablePush(api: PushApi, env: PushEnv): Promise<void> {
	const pm = await env.pushManager();
	if (!pm) throw new Error(PUSH_COPY.unsupported);
	const { vapidPublicKey } = await api.health();
	if (!vapidPublicKey) throw new Error(PUSH_COPY.noKey);
	if ((await env.requestPermission()) !== "granted") throw new Error(PUSH_COPY.denied);
	const key = base64UrlToBytes(vapidPublicKey);
	const sub = (await current(pm, key)) ?? (await pm.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
	await api.pushSubscribe(toInfo(sub));
}

export async function disablePush(api: PushApi, env: PushEnv): Promise<void> {
	const sub = await (await env.pushManager())?.getSubscription();
	if (!sub) return;
	// Unsubscribing locally is what matters: if the hub misses this, its next push gets a 410 and drops it.
	await api.pushUnsubscribe(sub.endpoint).catch(() => {});
	await sub.unsubscribe();
}

// On every connect: if this device has notifications on, make sure the hub has it,
// re-subscribing quietly (permission is already granted) when the hub's key changed.
export async function resyncPush(api: PushApi, env: PushEnv): Promise<void> {
	try {
		if ((await pushStatus(env)) === "on") await enablePush(api, env);
	} catch {}
}

export function openHashFromMessage(data: unknown): string | null {
	const d = data as { type?: unknown; sessionId?: unknown } | null;
	if (d?.type !== "pi-open" || typeof d.sessionId !== "string" || !d.sessionId) return null;
	return hrefFor({ name: "session", id: d.sessionId });
}

export function browserPushEnv(): PushEnv {
	const nav = navigator as Navigator & { standalone?: boolean };
	return {
		async pushManager() {
			if (!("serviceWorker" in nav) || !("PushManager" in globalThis)) return null;
			const reg = await nav.serviceWorker.getRegistration(); // none in dev, where the worker isn't registered
			return reg ? (reg.pushManager as unknown as PushManagerLike) : null;
		},
		permission: () => ("Notification" in globalThis ? Notification.permission : "unsupported"),
		requestPermission: () => Notification.requestPermission(),
		ios: /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1),
		standalone: matchMedia("(display-mode: standalone)").matches || nav.standalone === true,
	};
}

// The subscription already here, if it was made with this key. One made with another key
// (the hub regenerated its keys) can't be delivered to, so it is dropped.
async function current(pm: PushManagerLike, key: Uint8Array): Promise<PushSubLike | null> {
	const sub = await pm.getSubscription();
	if (!sub) return null;
	const have = sub.options?.applicationServerKey;
	if (have && sameBytes(new Uint8Array(have), key)) return sub;
	await sub.unsubscribe();
	return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

function toInfo(sub: PushSubLike): PushSubscriptionInfo {
	const keys = sub.toJSON().keys ?? {};
	return { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh ?? "", auth: keys.auth ?? "" } };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npm test -w app -- src/lib/push.test.ts && npm run typecheck -w app`
Expected: 8 tests PASS, and the typecheck is clean.

- [ ] **Step 6: The settings toggle**

In `app/src/components/pi-settings.ts`:

- Add the imports `import { PUSH_COPY, type PushStatus, browserPushEnv, disablePush, enablePush, pushStatus } from "../lib/push.ts";` and `import { getHubUrl } from "../lib/settings.ts";`. Merge the second into the existing `settings.ts` import, which already imports `getHubUrl`.
- Extend `static properties` with `push: { state: true }, pushBusy: { state: true }, pushError: { state: true }`. Add `declare push: PushStatus | null; declare pushBusy: boolean; declare pushError: string | null;`, and initialize all three in the constructor to `null`, `false` and `null`.
- Add the methods:

```ts
	connectedCallback(): void {
		super.connectedCallback();
		void this.refreshPush();
	}

	private async refreshPush(): Promise<void> {
		this.push = await pushStatus(browserPushEnv()).catch(() => "unsupported" as const);
	}

	private async setPush(on: boolean): Promise<void> {
		const url = getHubUrl();
		if (!url || this.pushBusy) return;
		this.pushBusy = true;
		this.pushError = null;
		try {
			const api = new HubApi(url);
			if (on) await enablePush(api, browserPushEnv());
			else await disablePush(api, browserPushEnv());
		} catch (err) {
			this.pushError = (err as Error).message;
		} finally {
			this.pushBusy = false;
			await this.refreshPush();
		}
	}

	private renderPush() {
		if (!getHubUrl()) return html`<p class="hint">${PUSH_COPY.noHub}</p>`;
		if (this.push === "install-first") return html`<p class="hint">${PUSH_COPY.installFirst}</p>`;
		if (this.push === "unsupported") return html`<p class="hint">${PUSH_COPY.unsupported}</p>`;
		if (this.push === "denied") return html`<p class="hint">${PUSH_COPY.denied}</p>`;
		if (this.push === null) return nothing;
		return html`<div class="seg" role="radiogroup" aria-label="Notifications">
				${(["off", "on"] as const).map(
					(v) => html`<button role="radio" aria-checked=${this.push === v ? "true" : "false"} class=${this.push === v ? "on" : ""} ?disabled=${this.pushBusy} @click=${() => this.setPush(v === "on")}>${v}</button>`,
				)}
			</div>
			${this.pushError ? html`<p class="status bad" role="status">${this.pushError}</p>` : nothing}`;
	}
```

- In `render()`, between the theme `seg` block and `<h2>install</h2>`, add:

```ts
			<h2>notifications</h2>
			<p class="hint">${PUSH_COPY.hint}</p>
			${this.renderPush()}
```

- [ ] **Step 7: Resync on connect, and route taps**

- In `app/src/components/pi-app.ts`, import `import { browserPushEnv, resyncPush } from "../lib/push.ts";`. At the end of `connectHub` (after `this.list.start();`), add `void resyncPush(this.api, browserPushEnv());`.
- In `app/src/main.ts`, inside the existing `if (import.meta.env.PROD && "serviceWorker" in navigator) { … }` block, after the `register` call, add the listener below, with `import { openHashFromMessage } from "./lib/push.ts";` at the top:

```ts
	navigator.serviceWorker.addEventListener("message", (e) => {
		const hash = openHashFromMessage(e.data);
		if (hash) location.hash = hash;
	});
```

- [ ] **Step 8: Docs**

In `README.md`, add this section right before `## Deploy`:

```markdown
## Notifications

Turn notifications on in settings. A device then gets a push when one of pi-web's headless sessions finishes a run with no app open on it, waits on a dialog, or stops with an error. Tapping the notification opens the session. Terminal sessions don't notify, because you are at the terminal.

On iPhone or iPad, add pi-web to the Home Screen first (Share → Add to Home Screen) and turn notifications on from the installed app. Safari tabs can't receive push.

The hub keeps its push keys in `~/.config/pi-web/vapid.json` and the subscribed devices in `~/.config/pi-web/push.json`. Deleting `vapid.json` makes new keys. Each device then re-subscribes the next time it opens pi-web.
```

Change the README's last paragraph, `Hub deployment (tailscale serve, systemd) and push notifications are Plans 3–4.`, to `Hub deployment (tailscale serve, systemd) is Plan 4.`

- [ ] **Step 9: Run everything, then commit**

Run: `npm run typecheck && npm test && npm run build -w app`
Expected: all PASS, and the build succeeds.

```bash
git add app/src/lib/push.ts app/src/lib/push.test.ts app/src/lib/api.ts app/src/components/pi-settings.ts app/src/components/pi-app.ts app/src/main.ts README.md
git commit -m "feat(app): notifications toggle; keep the hub's subscription in step; open the session on tap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Manual checklist (Michael, after Task 5, once the hub is restarted and the app is deployed)

- [ ] **Chrome on the Mac:** in settings, turn notifications on and allow them. Start a session from the app, send a prompt, and close the tab before it finishes. A "Finished." notification arrives, and clicking it opens the session.
- [ ] **iPhone:** in Safari, settings shows the Home Screen hint. Add pi-web to the Home Screen, open it from there, and turn notifications on. Run a prompt, then leave the app; a notification arrives. Tapping it opens the session, and dismissing it works.
- [ ] **Needs you:** with the app closed, run something that asks a question through an extension dialog. A "Needs you." notification arrives.
- [ ] **Off:** turn notifications off, and `~/.config/pi-web/push.json` no longer lists the device.

## After this plan

- **Plan 4: deploy.** A systemd user unit for the hub (replacing the transient one) and the `tailscale serve` entry. The bridge is already installed in `~/.pi/agent/settings.json` `packages`.
