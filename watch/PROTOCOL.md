# Watch ↔ phone protocol (AppMessage)

The watchapp (`app/src/embeddedjs/`) and its phone side (PebbleKit JS, `app/src/pkjs/bridge.js`) talk in AppMessage dicts. The phone turns hub frames (`docs/watch-api.md`) into `MSG` dicts for the watch and the watch's `CMD` dicts into hub calls. This file is written from the code: `bridge.js` (phone), `shared/js/link.js`, `app/src/embeddedjs/main.js` and `modules/model.js` (watch).

## Keys

The key names are `pebble.messageKeys` in `app/package.json`, in this order; a test checks `main.js` `KEYS` against them. Add a new key to `package.json` first.

`MSG CMD CMD_ID ID SESSION_ID LABEL SOURCE TEXT OPTIONS ROWS AT STATUS NOTICE NET DARK HUB_URL LIST PROVIDER MODEL_ID CODE OK`

- `HUB_URL` and `DARK` are also the Clay settings keys (`config.js`); `HUB_URL` never crosses AppMessage.
- `CMD_ID` is a counter the watch puts on every command (`link.js`); the phone ignores it.

## Separators and limits

- `ROWS` and `LIST` hold rows separated by `\x1e`; fields within a row, and the options in `OPTIONS`, are separated by `\x1f`. The phone strips tabs, newlines and both separators from every field (`bridge.js` `clean`).
- Each dict fits in 1000 bytes (`MSG_BYTES`; the watch's input buffer is 1100). The phone drops trailing rows (`fitRows`) and trims query or reply text in UTF-8 bytes, never inside a surrogate pair (`fitQuery`, `replyDict`).
- Other caps: 12 Home rows, a 40-character title or label, 600 characters of text, a 24-character option label (display only; the full option is what the phone sends to the hub), and a 120-character notice.
- STATUS letters: `w` waiting, `r` running, `d` done, `e` error.

## Phone → watch: `MSG`

| MSG | Fields | Meaning |
|---|---|---|
| `home` | `ROWS`: `id \x1f title \x1f status \x1f sub` per row | Home's session list, waiting sessions first. `sub` is the elapsed run time for running sessions, the time (`HH:MM`) for done ones, else empty. "+ New session" is the watch's own row and is never sent. |
| `query` | `ID`, `SOURCE` (`pi` or `ring`), `SESSION_ID` (empty for ring-profile), `LABEL`, `TEXT`, `OPTIONS`, `AT` | The query the watch should show: the oldest. |
| `query_gone` | `ID` | That query ended (answered, skipped, gone). The watch drops it only if it is the current one. |
| `reply` | `SESSION_ID`, `LABEL`, `TEXT`, `AT`, `STATUS` | The open session's last agent reply and status. No streamed text is relayed: while `STATUS` is `r` the watch keeps the text and shows a typing indicator. |
| `models` | `SESSION_ID`, `LIST`: `provider \x1f id \x1f name` per row | The answer to CMD `models`. |
| `notice` | `NOTICE` | A short line over the current screen ("Didn't catch that", "Already answered", "Hub unreachable", a hub error). |
| `cfg` | `DARK` (0 or 1) | The theme. |
| `net` | `NET`: `connecting`, `online`, `offline` or `unconfigured` | The phone's link to the hub. The watch shows "connecting" for 10 s at most, then offline. |

**Coalescing.** `home`, `reply`, `net` and `cfg` coalesce: a newer dict of the same MSG replaces one still queued, and a repeat of the last one sent is dropped (`bridge.js` `COALESCE`; the watch's held list in `main.js` does the same during a slide). `query`, `query_gone`, `models` and `notice` are always delivered in order. The phone sends one dict at a time and retries a failed send once after 500 ms.

## Watch → phone: `CMD`

| CMD | Fields | Phone does |
|---|---|---|
| `showing` | `ID` (a query), or `SESSION_ID` (a session), or neither (Home) | `POST /api/watch/showing`; a session screen also makes it the open session for `reply`. |
| `answer` | `ID`, `OK`: the option's index | `POST /api/watch/answer` with the full option text. |
| `skip` | `ID` | `POST /api/watch/skip`. Skip is its own command, not an `answer` index. |
| `open` | `SESSION_ID` | Fetches the last agent turn (`GET /api/watch/history`) and sends it as `reply`. |
| `continue` | `SESSION_ID` | `POST /api/watch/prompt` with the text "continue". |
| `stop` | `SESSION_ID` | `POST /api/watch/abort`. |
| `archive` | `SESSION_ID` | `POST /api/watch/archive`, then a new `home`. |
| `models` | `SESSION_ID` | `GET /api/watch/models`, answered with MSG `models`. |
| `model` | `SESSION_ID`, `PROVIDER`, `MODEL_ID` | `POST /api/watch/model`. |
| `launched` | none | Sent on every launch. A pending query opens first; otherwise the most recent session opens if the first frame lands within 9 s (`bridge.js` `resume`). No alert launches the app with a code any more: alerts are Web Push. |
| `new` | none | `POST /api/watch/new`, then opens the empty session it returns, if the watch is still on Home. |

A failed hub call becomes a `notice`: "Hub unreachable" for a network error or timeout, else the hub's `error` text or "Hub error <status>" (`bridge.js` `failText`).
