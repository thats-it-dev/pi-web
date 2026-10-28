# Watch API

The hub serves a small HTTP and WebSocket API under `/api/watch/*` for the Pebble watchapp, by way of its phone side (PebbleKit JS). It offers **queries** (pi dialogs and ring-profile questions) and the session list, takes answers, skips and prompts, and serves session history. `POST /api/index/webhook` receives voice notes from the Index 01 ring. The routes are in `hub/src/watch-routes.ts`, the stream in `hub/src/watch-stream.ts`, and the types in `shared/src/protocol.ts`. For what the watch does with them, see the [watch UI spec](superpowers/specs/2026-10-27-watch-ui-design.md). The AppMessage layer between the phone and the watch is in [watch/PROTOCOL.md](../watch/PROTOCOL.md). The loopback API for local services (ring-profile) is under "Hub side" in [watch/README.md](../watch/README.md#hub-side).

## Auth

Callers have no `Origin`. Every request needs the Tailscale identity: the `Host` header must be the hub's hostname and `Tailscale-User-Login` must be the allowed login. tailscale serve adds that header to any request from a tailnet device logged in as you, so the phone and the ring need only the hub's address. Anything that fails answers `403`. If the hub has no watch service it answers `503` once the identity check passes.

There is no token and no webhook signing. That means anything running on one of your tailnet devices, including a web page in a browser there that knows the hub's hostname, can use these routes as you. That is the trade chosen for a single-user tailnet.

Keep pi-web's notifications **on** in the Pebble app. When the watch app is closed and the Pebble app is in the background on iOS, the PWA's Web Push, mirrored to the watch, is the only alert that reaches the wrist (spec §7). The hub sends Web Push alerts only (see "Alerts"). Config `push` turns them on or off.

## Types

- `WatchPending`: `{ cursor, queries: WatchQuery[], showing: Showing | null, sessions: WatchSession[] }`.
- `WatchQuery`: `{ id, source, sessionId, label, text, options, createdAt }`.
  - `source` is `pi` or `ring-profile`.
  - A pi dialog's `id` is `dialog:<sessionId>:<dialogId>`, its `label` is `pi · <session title>`, and `options` are what the dialog offers (`["yes", "no"]` for a confirm; empty for input and editor dialogs).
  - A ring-profile query's `id` is `rp:<n>`, and its `sessionId` is `null`.
  - `queries` is sorted oldest first. pi dialogs are left out while pi-web is open in a browser, and after a skip; ring-profile queries are never held back.
- `WatchSession`: `{ id, title, state, status, live, model, contextPercent, contextTokens, contextWindow, tps, updatedAt }`.
  - `status` is `waiting` (a query or dialog is pending), `running`, `done` or `error` (the session's last turn errored).
  - `sessions` lists waiting sessions first, then the most recently active; up to 20 closed sessions are included, and archived sessions are hidden until they have newer activity.
- `Showing`: `{ queryId, sessionId }`, what the watch last reported on screen; `null` for Home.
- `WatchAnswerResult`: `{ ok: true }` or `{ ok: false, reason: "gone" | "no_match", options? }`.

## Routes

All bodies are JSON. Success is `200`, and a result with `ok: false` is still a `200`. A bad body or query answers `400`, with `{ error }`.

| Method | Path | Query / body | Response | Other statuses |
| --- | --- | --- | --- | --- |
| GET | `/api/watch/pending` | `since` (cursor), `wait=1` | `WatchPending` | |
| GET | `/api/watch/sessions` | | `{ sessions: WatchSession[] }` | |
| GET | `/api/watch/history` | `session` (required), `before` (turn index), `limit` (default 12, max 50) | `{ turns: { i, role, text }[], total }`; `role` is `you`, `agent` or `tool` | `404` unknown session |
| GET | `/api/watch/models` | `session` (required) | `{ current, models }`; rows are `{ provider, id, name }` | `404` session not running |
| GET | `/api/watch/health` | | `{ ok, hubVersion, sessions: { running, pending } }` | |
| POST | `/api/watch/showing` | `{ queryId: string \| null, sessionId?: string \| null }` | `{ ok: true }` | |
| POST | `/api/watch/answer` | `{ queryId, option }` or `{ queryId, text }`, exactly one | `WatchAnswerResult` | |
| POST | `/api/watch/skip` | `{ queryId }` | `{ ok: true }` | |
| POST | `/api/watch/prompt` | `{ sessionId, text }` | `WatchAnswerResult` (`gone` when the session can't be reopened) | `409` if the session refuses |
| POST | `/api/watch/abort` | `{ sessionId }` | `WatchAnswerResult` (`gone` when the session isn't running) | `409` if the session refuses |
| POST | `/api/watch/archive` | `{ sessionId }` | `{ ok: true }` | |
| POST | `/api/watch/new` | `{}` | `{ ok: true, sessionId }` | |
| POST | `/api/watch/model` | `{ sessionId, provider, modelId }` | `{ ok: true }` | `409` if the session refuses |
| POST | `/api/watch/launch` | `{ uuid }` (the watchapp's uuid) | `{ ok: true }` or `{ ok: false, reason: "no_phone" \| "unreachable" }` | `400` bad uuid |
| POST | `/api/index/webhook` | multipart | empty `200` (also for a duplicate, which is ignored) | `400`, `413` |

Notes:

- **answer.** An `option` must be one of the query's `options`. For a pi dialog, `text` is matched to an option the way a ring note is (`hub/src/answer-match.ts`; input and editor dialogs take the text as is). For a ring-profile query, `text` is a `ring-answer` outcome. `no_match` returns the `options` the query accepts, and nothing is answered. `gone` means the query is no longer open.
- **skip.** Skip on a pi dialog only hides it from the watch: pi keeps waiting, and the dialog stays answerable in the web app (spec §4.3). Skip on a ring-profile query ends it with the outcome `skip`.
- **showing.** `queryId` is required (`null` when no query is on screen). With a query, `sessionId` defaults to the dialog's session. The report also counts as the app being seen (see "Webhook" below) and marks the query as delivered.
- **prompt** sends `{ type: "prompt", text, mode: "send" }` to the session, reopening a closed one from its file. The watch's Continue sends the text "continue".
- **new** creates an empty pi session in `~/pebble`, with the same folder and model choice as a ring note's new session, and sends no prompt.
- **archive** hides a session from `sessions` until it has newer activity. The list is kept in `<dataDir>/watch-archive.json`.
- **history** pages back: pass the earliest `i` you have as `before`.

## Stream

`GET /api/watch/stream` upgrades to a WebSocket and carries the same data as the long-poll without the wait. Auth is the same Host and `Tailscale-User-Login` check, applied to the upgrade request: a failure answers `403` (an unknown path `404`) and no socket opens. Frames are JSON text (`WatchStreamFrame`).

Hub to client:

| Frame | When |
| --- | --- |
| `{ type: "pending", cursor, queries, showing, sessions }` | once on connect, then whenever the cursor moves (one frame per burst of changes; speed ticks for the current session at most once a second) |
| `{ type: "text", sessionId, text, streaming }` | while the current session (the `sessionId` the client last reported in `showing`) streams a reply: the last 240 characters of the partial message, at most every 250 ms, and once more with `streaming: false` when it ends. Sent at once when `showing` moves onto a session that is mid-reply. The watchapp's phone side relays no streamed text (`streaming: true`); it fetches the finished reply from `history`. |
| `{ type: "notice", text }` | a ring note for the query on screen didn't match ("Didn't catch that") or found it answered already ("Already answered"). Notices go to stream clients only; a long-polling phone gets none. |

Client to hub:

| Frame | Meaning |
| --- | --- |
| `{ type: "showing", queryId, sessionId? }` | same as `POST /api/watch/showing`; it also selects the session whose text is streamed |

Anything else is ignored. Answers, skips, prompts and model changes stay HTTP POSTs. The hub pings every 30 s, drops a socket that misses two pongs, and closes every socket with code 1001 when it shuts down. A reconnecting client gets a full `pending` frame; `text` is a tail, not a delta.

From a tailnet device tailscale serve adds the identity headers, so a browser's `new WebSocket("wss://<hostname>/api/watch/stream")` is enough. Without wscat, from the repo root (where `ws` is installed):

```bash
node -e 'const ws = new (require("ws"))(process.argv[1], { headers: { host: "<hostname>", "tailscale-user-login": "<login>" } }); ws.on("message", (m) => console.log(String(m)))' wss://<hostname>/api/watch/stream
```

## Long-poll

The fallback when a WebSocket is not available. `GET /api/watch/pending` returns at once. Add `wait=1` and `since=<cursor>` to hold the request open until the cursor moves past `since`, or for 25 seconds, whichever comes first. Either way the reply is the full `WatchPending`; keep its `cursor` and send it as the next `since`. A client that goes away is dropped from the wait. If `since` is missing or not a number, it counts as 0. A held poll counts as an open app for the alerts (see "Alerts"), but notices are not delivered over long-poll.

## Alerts

The hub's Notifier (`hub/src/notifier.ts`) sends Web Push only; the phone shows the push and mirrors it to the watch. No Developer Connection notification is sent and nothing launches the watch app with a code. Config `push` (boolean, default `true`) turns the alerts on or off. The earlier `watchAlert` setting still loads: `"off"` becomes `push: false`, any other value `push: true`.

- **Titles** are at most 24 characters. A finished turn uses the agent's `TL;DR [title]` line, else `<project> · done`. Other events use `<project> · approve?`, `question`, `error` or `waiting`; a ring-profile question uses `ring · question`.
- **Bodies:** a finished turn carries the agent's TL;DR summary, else the clipped reply. A dialog carries its message. A ring-profile question push carries the question text. A ring note's receipt or miss ("Answered: <option>", "Didn't catch that") is pushed too.
- **Every pi dialog is pushed once.** A dialog raised while a visible PWA is viewing its session is held, and pushed when the PWA leaves the session if it is still pending. A pushed dialog is marked alerted, which lets a closed-app ring note answer it.
- **Per-session suppression:** a push for session S is held back only while a visible PWA reports viewing S (`GET /api/events?viewing=<id>`). Whether the watch app is open does not matter.
- **Still waiting:** one reminder, `Still waiting: <body>`, 15 minutes after a dialog's or ring question's push if it is still unanswered.
- **TL;DR:** headless pi sessions are spawned with `--append-system-prompt` carrying the TL;DR rule, and the PWA hides the TL;DR line.

## Launch

`POST /api/watch/launch` with `{ uuid }` opens a watchapp through the phone's Developer Connection. The watchapp doesn't call it; it is kept for tools. The hub opens `ws://<phone>:9000/`, sends one binary frame and closes. The frame is 22 bytes: `01` (RelayToWatch), `0011` (payload length 17), `0034` (AppRunState endpoint), `01` (start), then the 16 uuid bytes.

- `{ ok: true }`: the frame was sent.
- `{ ok: false, reason: "no_phone" }`: no phone address is known. The launch request itself records the caller's address, so an ordinary request doesn't get this.
- `{ ok: false, reason: "unreachable" }`: the connection failed or timed out after 5 s. This is also a `200`.

The phone must have Developer Connection switched on in the Pebble app and be reachable from the hub over the tailnet. On iOS that holds only while the Pebble app is in the foreground (spec §7). The hub targets the first entry of the last `X-Forwarded-For` it saw on any watch request or stream upgrade, when that entry is an IP address. Otherwise it uses the socket's address, with a leading `::ffff:` stripped.

## Webhook

The ring posts a `multipart/form-data` body to `POST /api/index/webhook` (up to 25 MiB, else `413`) with these headers:

| Header | Meaning |
| --- | --- |
| `X-Index-Webhook-Version` | must be `1` (else `400`) |
| `X-Index-Trigger` | what started the recording |
| `X-Index-Test` | `true` for a test event, which is accepted and then ignored |
| `X-Index-Delivery` | a unique id per delivery, if sent; one seen in the last hour is acknowledged with `200` and ignored |
| `X-Index-Timestamp`, `X-Index-Signature` | read into the sidecar, not checked |
| `X-Audio-Size` | audio size (read, not checked) |

Leave "Sign requests" off in the Index app; a signature is ignored if sent.

The parts the hub reads are `audio`, `transcription`, `recordedAt` and `client`. `recordedAt` can be epoch milliseconds, epoch seconds (any number below 1e11) or a date string. The transcription is trimmed and cut to 8000 characters.

**Re-uploads.** The real Index app sends no `X-Index-Delivery`. Without one, the hub keys the delivery by its content: `sha256(recordedAt, transcription, audio bytes)`, named `content-<32 hex>`. The same note uploaded again gets `200` and does nothing (a non-2xx could keep the app re-sending it): within an hour the replay cache catches it, and after that, or after a restart, its stored sidecar does (until the newest-200 pruning drops it). The closed-app path also ignores any note recorded more than 10 minutes before it arrives, so a late retry can't answer a second dialog. Two notes differ in `recordedAt` or audio. A note with neither `recordedAt` nor audio can't be told apart from another saying the same words, so it is not de-duplicated, and it gets a random name.

The hub then picks an outcome (routing in the [watch UI spec](superpowers/specs/2026-10-27-watch-ui-design.md) §5).

**When the app counts as closed.** The app is closed when no app has held the stream or a long-poll, or posted `showing`, for 45 s.
- The hub starts inside this grace period, so a restart isn't a closed app.
- Within the 45 s (a reconnect blip, the gap between polls, a restart), the note is routed by the last-known `showing` as if the app were open. A half-open socket after the app closed counts as open until it misses two pings (about 60–90 s).
- In both windows the note goes to the last-shown query or session, or it starts a new session. It can answer (and approve) the query last on screen, but it never picks a dialog that was not on screen.
- A query that ended after the watch reported it is `gone`; the note never becomes a prompt or a new session.
- With nothing connected, the answer gets the closed path's receipt or miss alert. If the query is no longer offered to the watch (for example, held back while pi-web is open in a browser), the note answers nothing.

**With the app closed**, the note may answer only the oldest pi dialog that:
- is a select or confirm dialog with options (never input or editor);
- was alerted (a push reached the phone, or the watch showed it);
- existed at `recordedAt` (+2 s). Without a usable `recordedAt` the closed path is skipped and a session starts;
- is neither skipped on the watch nor held back while pi-web is open in a browser.

Ring-profile queries are answered only on screen. While the app is open, a query that is pending but not on screen is never answered.

| Outcome | When |
| --- | --- |
| `answered` | The transcription answered the query the watch is showing or, with the app closed, the eligible pi dialog. With the app closed, or with nothing connected during the grace period, the hub pushes one receipt, "Answered: <option>", with the dialog's label. |
| `no_match` | The note did not fit that query (the sidecar `reason` lists the options). Nothing is approved or denied. On screen the watch flashes "Didn't catch that". With the app closed, or with nothing connected during the grace period, the hub pushes one alert, "Didn't catch that", with the dialog's label and options. |
| `gone` | The query had already been answered. On screen the watch flashes "Already answered"; with the app closed, nothing is sent. |
| `prompted` | No query was on screen and a session was open on the watch, so the text went to that session as a prompt. |
| `new_session` | No session was open and there was nothing to answer: no query on screen and, with the app closed, no eligible pi dialog. A session started in `~/pebble` with the text as its prompt. |
| `kept_audio` | The transcription was empty, so only the audio is kept. |
| `error` | Deciding failed; `reason` holds the message. |

Once the headers pass and the delivery isn't a repeat, the hub answers `200` whatever the outcome.

Each delivery is stored in `<dataDir>/index/` as `<delivery>.m4a` (when there was audio) and `<delivery>.json`. The JSON holds:
- the headers, without the signature;
- `transcription`, `recordedAt`, `recordedMs` (the parsed time) and `client`;
- `action`;
- `sessionId`, `queryId` or `reason`, where they apply.

`<delivery>` is the header id, else the content key, else a random UUID. The log line is `index: <delivery> <outcome> <query or session id> (<reason>)`, leaving out the parts that are empty. The newest 200 deliveries are kept.

### Notes webhook

`POST /api/index/notes` is the ring's second webhook, for notes about you rather than for pi. Point a second Index webhook at it. It takes the same headers and multipart parts as `/api/index/webhook`, with the same tailnet identity rule, the same `400` and `413` answers, and the same test-event handling. It shares the same de-duplication: the replay cache by `X-Index-Delivery` or content key, then the stored sidecar. A repeat is acknowledged with `200` and nothing is forwarded. The watch API need not be set up for this route.

A note never answers a query, prompts a session or starts one. The hub stores it in `<dataDir>/index/` like an agent delivery: the audio, and a sidecar with `action: "forwarded"`. When forwarding is off, the action is `"stored"`. The newest-200 pruning counts both webhooks' deliveries together. The hub then forwards the note to the ring-profile service at `POST {ringProfileUrl}/notes` with this JSON:

| Field | Value |
| --- | --- |
| `dedupeKey` | the delivery name (header id, else content key, else a random UUID) |
| `deliveryId` | `X-Index-Delivery`, when sent |
| `recordedAt` | the parsed `recordedAt` in epoch ms, else the hub's receive time |
| `receivedAt` | the hub's receive time, epoch ms |
| `transcript` | the transcription, trimmed (not cut) |
| `audioBase64` | the audio, when there was any |
| `webhook` | `"notes"` |

Once the headers pass, the ring gets `200` without waiting for the forward. The note is first written to `<dataDir>/index/outbox/<delivery>.json` and tried at once, with a 10 s timeout. A `2xx` deletes the file. Anything else leaves it there, and the hub retries every queued note every 60 s and at startup. The log line is `notes: <delivery> forwarded`, or `queued` when the first try failed, or `stored` when forwarding is off.

`ringProfileUrl` in `config.json` sets the service, and defaults to `http://127.0.0.1:7880`. Set it to `""` to turn forwarding off: notes are then only stored, and no outbox is created.

## Examples

Set the host once. Every call needs the tailnet identity, so run these from a device on the tailnet that `tailscale serve` recognises as you.

```bash
HOST=https://<hostname>
```

Wait up to 25 seconds for something new (start with `since=0`, then pass back the `cursor` you got):

```bash
curl -sS "$HOST/api/watch/pending?since=0&wait=1"
```

Answer a query with one of its options (the id comes from `queries[].id`):

```bash
curl -sS -X POST "$HOST/api/watch/answer" \
  -H "Content-Type: application/json" \
  -d '{"queryId":"dialog:<sessionId>:<dialogId>","option":"allow"}'
```

Skip it instead:

```bash
curl -sS -X POST "$HOST/api/watch/skip" \
  -H "Content-Type: application/json" \
  -d '{"queryId":"dialog:<sessionId>:<dialogId>"}'
```

Send a webhook as the ring would (the Index app sends no delivery id, so the hub keys it by content):

```bash
printf -- '--b\r\nContent-Disposition: form-data; name="transcription"\r\n\r\nyes\r\n--b\r\nContent-Disposition: form-data; name="recordedAt"\r\n\r\n%s\r\n--b--\r\n' "$(date +%s%3N)" > body.bin

curl -sS -i -X POST "$HOST/api/index/webhook" \
  -H "Content-Type: multipart/form-data; boundary=b" \
  -H "X-Index-Webhook-Version: 1" -H "X-Index-Trigger: single-click-hold" \
  --data-binary @body.bin
```

A `200` with an empty body means it was accepted. The outcome is in the newest `<dataDir>/index/content-*.json` and in the hub's log line. Sending the same `body.bin` again within an hour gets `200` and is ignored (the log says `duplicate delivery ignored`).
