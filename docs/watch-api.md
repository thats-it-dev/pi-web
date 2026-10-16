# Watch API

The hub serves a small HTTP API under `/api/watch/*` for the Pebble watch, by way of the phone app. It lists what the watch may show (dialogs, finished runs, errors), takes answers and prompts, and serves session history. A second route, `POST /api/index/webhook`, receives voice notes from the Index 01 ring. For what the watch does with it all, see the [design spec](superpowers/specs/2026-10-16-pebble-watch-design.md).

## Auth

Callers have no `Origin`. Every request needs the Tailscale identity (the `Host` header must be the hub's hostname and `Tailscale-User-Login` must be the allowed login), then, for `/api/watch/*`, `Authorization: Bearer <token>`. Anything that fails answers `403`. If the hub has no watch service it answers `503` once the identity check passes. The webhook skips the bearer token and is signed instead (see below).

The hub makes the token and the Index secret on first start and keeps them in `<dataDir>/watch.json` (`~/.config/pi-web/watch.json`, or `$PI_WEB_DATA_DIR`) as `token` and `indexSecret`. The app's settings page shows both. Deleting the file makes new ones, and the watch and ring must then be set up again.

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
| POST | `/api/index/webhook` | multipart, signed | empty `200` | `400`, `401`, `409`, `413` |

A `WatchRequest` is `{ id, kind, sessionId, sessionTitle, tool, message, options, method, createdAt }`. `kind` is `dialog`, `finished` or `error`, and `id` is `dialog:<sessionId>:<dialogId>`, `finished:<sessionId>:<messageIndex>` or `error:<sessionId>:<messageIndex>`. A `WatchSession` is `{ id, title, state, live, model, contextPercent, contextTokens, contextWindow, tps, updatedAt }`.

Notes:

- `answer` to a `dialog` takes an `option` or free `text`. Answering a `finished` or `error` request takes `text` only, which is sent to that session as a prompt. `no_match` returns the `options` the dialog does accept.
- `gone` means the request is no longer open. It is a `200`, not an error.
- `pending` returns an empty `requests` list while an app is open on a session, because the app is already showing them.
- `history` pages back: pass the earliest `i` you have as `before`.

## Long-poll

`GET /api/watch/pending` returns at once. Add `wait=1` and `since=<cursor>` to hold the request open until the cursor moves past `since`, or for 25 seconds, whichever comes first. Either way the reply is the full `WatchPending`; keep its `cursor` and send it as the next `since`. A client that goes away is dropped from the wait. If `since` is missing or not a number, it counts as 0.

## Webhook

The ring posts a `multipart/form-data` body to `POST /api/index/webhook` (up to 25 MiB, else `413`) with these headers:

| Header | Meaning |
| --- | --- |
| `X-Index-Webhook-Version` | must be `1` (else `400`) |
| `X-Index-Trigger` | what started the recording |
| `X-Index-Test` | `true` for a test event, which is verified and then ignored |
| `X-Index-Timestamp` | Unix seconds, integer |
| `X-Index-Delivery` | a unique id per delivery |
| `X-Index-Signature` | lowercase hex HMAC-SHA-256 |
| `X-Audio-Size` | audio size (read, not checked) |

The signature is HMAC-SHA-256, keyed with `indexSecret` as the literal hex string (not decoded), over the prefix bytes followed by the raw request body:

```
v1\n<timestamp>\n<delivery>\n<trigger>\n<1 if X-Index-Test is "true", else 0>\n
```

Each `\n` is a single newline byte. A missing signature, timestamp or delivery is `401`; a bad timestamp is `400`. A timestamp more than 300 seconds from the hub's clock is `401` "Expired request". A wrong signature is `401`. A delivery id seen in the last hour is `409`.

The parts the hub reads are `audio`, `transcription`, `recordedAt` and `client`. The transcription is trimmed and cut to 8000 characters. The hub then picks an outcome:

| Outcome | When |
| --- | --- |
| `answered` | the transcription answered the request the watch is showing |
| `no_match` | it did not fit that request (the sidecar `reason` lists the options) |
| `new_session` | the watch is showing nothing, so a session started in `~/pebble` with the text as its prompt |
| `kept_audio` | the transcription was empty, so only the audio is kept |
| `error` | deciding failed; `reason` holds the message |

Once the signature checks out, the hub answers `200` whatever the outcome. Each delivery is stored in `<dataDir>/index/` as `<delivery>.m4a` (when there was audio) and `<delivery>.json` (headers without the signature, transcription, `recordedAt`, `client`, `action`, and `sessionId`, `requestId` or `reason` where they apply). The newest 200 are kept.

## Examples

Set the host and token once. Every call needs the tailnet identity, so run these from a device on the tailnet that `tailscale serve` recognises as you.

```bash
HOST=https://<hostname>
TOKEN=$(jq -r .token ~/.config/pi-web/watch.json)
```

Wait up to 25 seconds for something new (start with `since=0`, then pass back the `cursor` you got):

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$HOST/api/watch/pending?since=0&wait=1"
```

Answer a dialog with one of its options (the id comes from `requests[].id`):

```bash
curl -sS -X POST "$HOST/api/watch/answer" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"dialog:<sessionId>:<dialogId>","option":"Allow"}'
```

Send a signed webhook. Write the body to a file first so the signature and the request cover the same bytes:

```bash
SECRET=$(jq -r .indexSecret ~/.config/pi-web/watch.json)
TS=$(date +%s); DELIVERY=$(uuidgen); TRIGGER=button; TEST=0   # TEST=1 if you send X-Index-Test: true

printf -- '--b\r\nContent-Disposition: form-data; name="transcription"\r\n\r\nyes\r\n--b--\r\n' > body.bin

{ printf 'v1\n%s\n%s\n%s\n%s\n' "$TS" "$DELIVERY" "$TRIGGER" "$TEST"; cat body.bin; } > signed.bin
SIG=$(openssl dgst -sha256 -hmac "$SECRET" -r signed.bin | cut -d' ' -f1)

curl -sS -i -X POST "$HOST/api/index/webhook" \
  -H "Content-Type: multipart/form-data; boundary=b" \
  -H "X-Index-Webhook-Version: 1" -H "X-Index-Trigger: $TRIGGER" \
  -H "X-Index-Timestamp: $TS" -H "X-Index-Delivery: $DELIVERY" \
  -H "X-Index-Signature: $SIG" \
  --data-binary @body.bin
```

A `200` with an empty body means the signature passed; the outcome is in `<dataDir>/index/$DELIVERY.json`.
