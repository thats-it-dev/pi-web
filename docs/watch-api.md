# Watch API

The hub serves a small HTTP API under `/api/watch/*` for the Pebble watch, by way of the phone app. It lists what the watch may show (dialogs, finished runs, errors), takes answers and prompts, and serves session history. A second route, `POST /api/index/webhook`, receives voice notes from the Index 01 ring. For what the watch does with it all, see the [design spec](superpowers/specs/2026-10-16-pebble-watch-design.md).

## Auth

Callers have no `Origin`. Every request needs the Tailscale identity: the `Host` header must be the hub's hostname and `Tailscale-User-Login` must be the allowed login. tailscale serve adds that header to any request from a tailnet device logged in as you, so the face, the app and the ring need only the hub's address. Anything that fails answers `403`. If the hub has no watch service it answers `503` once the identity check passes.

There is no token and no webhook signing. That means anything running on one of your tailnet devices, including a web page in a browser there that knows the hub's hostname, can use these routes as you. That is the trade chosen for a single-user tailnet; the earlier token-and-signature version is in git history if it is ever wanted back.

Do this once in the Pebble app: mute pi-web in its notification settings. The hub already pushes to the phone, and without the mute each request arrives twice.

## Routes

All bodies are JSON. Success is `200`. A bad body or query answers `400`.

| Method | Path | Query / body | Response | Other statuses |
| --- | --- | --- | --- | --- |
| GET | `/api/watch/pending` | `since` (cursor), `wait=1` | `WatchPending`: `{ cursor, requests, showing, sessions }` | |
| GET | `/api/watch/sessions` | | `{ sessions: WatchSession[] }` | |
| GET | `/api/watch/history` | `session` (required), `before` (turn index), `limit` (default 12, max 50) | `{ turns: { i, role, text }[], total }` | `400`, `404` unknown session |
| GET | `/api/watch/models` | `session` (required) | `{ current, models }`, rows are `{ provider, id, name }` | `400`, `404` session not running |
| GET | `/api/watch/health` | | `{ ok, hubVersion, sessions: { running, pending } }` | |
| GET | `/api/watch/weather` | `lat`, `lon` (numbers) | `{ tempC, code }` (WMO code, cached 10 min) | `400`, `502` upstream failed |
| POST | `/api/watch/showing` | `{ requestId: string \| null, sessionId?: string \| null }` | `{ ok: true }` | |
| POST | `/api/watch/answer` | `{ requestId, option }` or `{ requestId, text }`, exactly one | `{ ok: true }` or `{ ok: false, reason: "gone" \| "no_match", options? }` | |
| POST | `/api/watch/dismiss` | `{ requestId }` | `{ ok: true }` | |
| POST | `/api/watch/prompt` | `{ sessionId, text }` | same as answer | |
| POST | `/api/watch/model` | `{ sessionId, provider, modelId }` | `{ ok: true }` | `409` if the session refuses |
| POST | `/api/watch/launch` | `{ uuid }` (the watchapp's uuid) | `{ ok: true }` or `{ ok: false, reason: "no_phone" \| "unreachable" }` | `400` bad uuid |
| POST | `/api/index/webhook` | multipart | empty `200` | `400`, `409`, `413` |

A `WatchRequest` is `{ id, kind, sessionId, sessionTitle, tool, message, options, method, createdAt }`. `kind` is `dialog`, `finished` or `error`, and `id` is `dialog:<sessionId>:<dialogId>`, `finished:<sessionId>:<messageIndex>` or `error:<sessionId>:<messageIndex>`. A `WatchSession` is `{ id, title, state, live, model, contextPercent, contextTokens, contextWindow, tps, updatedAt }`.

Notes:

- `answer` to a `dialog` takes an `option` or free `text`. Answering a `finished` or `error` request takes `text` only, which is sent to that session as a prompt. `no_match` returns the `options` the dialog does accept.
- `gone` means the request is no longer open. It is a `200`, not an error.
- `pending` returns an empty `requests` list while an app is open on a session, because the app is already showing them.
- `history` pages back: pass the earliest `i` you have as `before`.

## Stream

`GET /api/watch/stream` upgrades to a WebSocket and carries the same data as the long-poll without the wait. Auth is the same Host and `Tailscale-User-Login` check, applied to the upgrade request: a failure answers `403` (an unknown path `404`) and no socket opens. Frames are JSON text.

Hub to client:

| Frame | When |
| --- | --- |
| `{ type: "pending", cursor, requests, showing, sessions }` | once on connect, then whenever the cursor moves (one frame per burst of changes; speed ticks for the current session at most once a second) |
| `{ type: "text", sessionId, text, streaming }` | while the current session (the `sessionId` the client last reported in `showing`) streams a reply: the last 240 characters of the partial message, at most every 250 ms, and once more with `streaming: false` when it ends. Sent at once when `showing` moves onto a session that is mid-reply. |

Client to hub:

| Frame | Meaning |
| --- | --- |
| `{ type: "showing", requestId, sessionId? }` | same as `POST /api/watch/showing`; it also selects the session whose text is streamed |

Anything else is ignored. Answers, dismissals, prompts and model changes stay HTTP POSTs. The hub pings every 30 s, drops a socket that misses two pongs, and closes every socket with code 1001 when it shuts down. A reconnecting client gets a full `pending` frame; `text` is a tail, not a delta.

From a tailnet device tailscale serve adds the identity headers, so a browser's `new WebSocket("wss://<hostname>/api/watch/stream")` is enough. Without wscat, from the hub's workspace (where `ws` is installed):

```bash
node -e 'const ws = new (require("ws"))(process.argv[1], { headers: { host: "<hostname>", "tailscale-user-login": "<login>" } }); ws.on("message", (m) => console.log(String(m)))' wss://<hostname>/api/watch/stream
```

## Launch

The watchface calls `POST /api/watch/launch` with `{ uuid }` when the phone's own loopback path to the Developer Connection fails. The hub opens `ws://<phone>:9000/` and sends one binary frame, then closes. The frame is 22 bytes: `01` (RelayToWatch), `0011` (payload length 17), `0034` (AppRunState endpoint), `01` (start), then the 16 uuid bytes.

- `{ ok: true }`: the frame was sent.
- `{ ok: false, reason: "no_phone" }`: the hub has not yet seen a watch request, so it has no address.
- `{ ok: false, reason: "unreachable" }`: the connection failed or timed out after 5 s. Both are `200`.

The phone must have Developer Connection switched on in the Pebble app and be reachable from the hub over the tailnet. The hub targets the first entry of the last `X-Forwarded-For` it saw on any watch request or stream upgrade, falling back to the socket's address (a leading `::ffff:` is stripped).

## Long-poll

The fallback when a WebSocket is not available. `GET /api/watch/pending` returns at once. Add `wait=1` and `since=<cursor>` to hold the request open until the cursor moves past `since`, or for 25 seconds, whichever comes first. Either way the reply is the full `WatchPending`; keep its `cursor` and send it as the next `since`. A client that goes away is dropped from the wait. If `since` is missing or not a number, it counts as 0.

## Webhook

The ring posts a `multipart/form-data` body to `POST /api/index/webhook` (up to 25 MiB, else `413`) with these headers:

| Header | Meaning |
| --- | --- |
| `X-Index-Webhook-Version` | must be `1` (else `400`) |
| `X-Index-Trigger` | what started the recording |
| `X-Index-Test` | `true` for a test event, which is accepted and then ignored |
| `X-Index-Delivery` | a unique id per delivery; one seen in the last hour is `409` |
| `X-Index-Timestamp`, `X-Index-Signature` | read into the sidecar, not checked |
| `X-Audio-Size` | audio size (read, not checked) |

Leave "Sign requests" off in the Index app; a signature is ignored if sent.

The parts the hub reads are `audio`, `transcription`, `recordedAt` and `client`. The transcription is trimmed and cut to 8000 characters. The hub then picks an outcome:

| Outcome | When |
| --- | --- |
| `answered` | the transcription answered the request the watch is showing |
| `no_match` | it did not fit that request (the sidecar `reason` lists the options) |
| `new_session` | the watch is showing nothing, so a session started in `~/pebble` with the text as its prompt |
| `kept_audio` | the transcription was empty, so only the audio is kept |
| `error` | deciding failed; `reason` holds the message |

Once the headers pass, the hub answers `200` whatever the outcome. Each delivery is stored in `<dataDir>/index/` as `<delivery>.m4a` (when there was audio) and `<delivery>.json` (headers without the signature, transcription, `recordedAt`, `client`, `action`, and `sessionId`, `requestId` or `reason` where they apply). The newest 200 are kept.

## Examples

Set the host once. Every call needs the tailnet identity, so run these from a device on the tailnet that `tailscale serve` recognises as you.

```bash
HOST=https://<hostname>
```

Wait up to 25 seconds for something new (start with `since=0`, then pass back the `cursor` you got):

```bash
curl -sS "$HOST/api/watch/pending?since=0&wait=1"
```

Answer a dialog with one of its options (the id comes from `requests[].id`):

```bash
curl -sS -X POST "$HOST/api/watch/answer" \
  -H "Content-Type: application/json" \
  -d '{"requestId":"dialog:<sessionId>:<dialogId>","option":"Allow"}'
```

Send a webhook as the ring would:

```bash
DELIVERY=$(uuidgen); TRIGGER=single-click-hold

printf -- '--b\r\nContent-Disposition: form-data; name="transcription"\r\n\r\nyes\r\n--b--\r\n' > body.bin

curl -sS -i -X POST "$HOST/api/index/webhook" \
  -H "Content-Type: multipart/form-data; boundary=b" \
  -H "X-Index-Webhook-Version: 1" -H "X-Index-Trigger: $TRIGGER" \
  -H "X-Index-Delivery: $DELIVERY" \
  --data-binary @body.bin
```

A `200` with an empty body means it was accepted; the outcome is in `<dataDir>/index/$DELIVERY.json`. Sending the same `DELIVERY` again within an hour is `409`.
