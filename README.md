# pi, that's it.

A PWA for the [pi](https://pi.dev) coding agent running on spark: browse every
session (CLI or app), continue them with live streaming, start new ones, switch
models and thinking levels, watch context usage, use slash commands, and @-mention files. Styled
after thatsit.dev.

- `hub/`: Node server on spark. Runs one headless `pi --mode rpc` per open
  session, serves REST + SSE, accepts only your Tailscale identity from the
  app's origin. Zero runtime dependencies; runs `.ts` directly on Node ≥ 22.18.
- `app/`: Vite + Lit PWA (static; deploys to pi.thatsit.app).
- `shared/`: wire types and the conversation reducer both sides use.
- Design: `docs/superpowers/specs/2026-10-10-pi-web-design.md`.

## Develop

```bash
npm install
mkdir -p .dev-data && cat > .dev-data/config.json <<'JSON'
{ "port": 7878, "hostname": "localhost:5173", "allowedLogin": "dev@local", "dev": true }
JSON
npm run dev -w hub    # hub on 127.0.0.1:7878, using your real ~/.pi/agent sessions
npm run dev -w app    # app on http://localhost:5173 (proxies /api and plays tailscale serve)
```

From another machine: `ssh -L 5173:localhost:5173 spark-713a`, then open
http://localhost:5173.

## Test

```bash
npm test              # shared + hub + bridge (node:test, real pi against a fake model) + app (vitest)
npm run typecheck
npm run e2e -w app    # Playwright: desktop + phone flows against the real hub
```

Tests never touch `~/.pi/agent`: every pi they start gets a temporary
`PI_CODING_AGENT_DIR` with a fake OpenAI-compatible model. The e2e hub also
uses a temporary `PI_WEB_DATA_DIR` (port 7898).

## Configure for real use

`~/.config/pi-web/config.json` (created on first start):

```json
{
  "port": 7878,
  "hostname": "spark-713a.tail9274fa.ts.net:7878",
  "allowedLogin": "michaelthatsit@github",
  "allowedOrigins": ["https://pi.thatsit.app"],
  "idleMinutes": 20,
  "maxHeadless": 6,
  "piBin": "pi",
  "approvalMode": "auto",
  "watchAlert": "auto"
}
```

`watchAlert` is how the hub alerts the Pebble watch when its app is closed: `auto` (default) sends a notification with an Open action through the phone's Developer Connection and, if the phone is unreachable (the Pebble app must be in the foreground on iOS), falls back to a Web Push; `notification` and `push` use only one of those; `off` sends nothing.

`approvalMode` is the approval mode new app-started sessions begin in; the session settings sheet in the app (the sliders next to the model) changes it per session. While a turn is running, the hub answers a permission extension's Allow/Deny select (picking Allow) or yes/no confirm itself, so the agent keeps going with the app closed:

- `auto`: for every tool call.
- `semi`: only for obviously benign calls: reading, listing or searching inside the session folder, writing or editing a file inside it, or a read-only shell command (`ls`, `cat`, `grep`, `git status`, …). Everything else asks in the app.
- `manual`: never; every flagged call asks in the app.

Dialogs outside a running turn, inputs, and selects without an allow option always reach the app.

## Updating the hub from the app

Settings → hub → "check for updates" asks the hub where its checkout stands against `origin/master`; "update & restart" runs `git pull --ff-only origin master` and `npm install` in the checkout and exits, and the systemd unit (`Restart=always`) brings it back on the new code. The hub refuses while a session is mid-turn, unless you choose "update anyway", and when the checkout has local changes. Only the hub updates this way; the app itself deploys from Cloudflare Pages on every push to master.

## Terminal sync (bridge)

A pi started in a terminal shows up live in pi-web when it loads the bridge extension in `bridge/`. Load it for one run:

```bash
pi -e ~/workspace/pi-web/bridge/index.ts
```

Or load it for every run:

```bash
pi install ~/workspace/pi-web/bridge
```

The bridge connects to the hub at `~/.config/pi-web/bridge.sock`. Set `PI_WEB_BRIDGE_SOCKET` to use another socket, for example `.dev-data/bridge.sock` for `npm run dev -w hub`. If the hub isn't running, the bridge waits quietly and connects when it starts.

From the app you can watch the terminal session stream, prompt, steer and queue follow-ups, switch the model and thinking level, compact, and rename. Fork, clone, `!bash`, export and extension commands stay in the terminal, and extension dialogs show as "waiting for you in the terminal". If the app is running a reply in headless pi when you resume that session in a terminal, the terminal is told to wait. When the reply finishes, the terminal is told the session is free: `/resume` it there to continue with the latest messages. The same goes for a session open in another terminal, once that terminal quits or moves on.

## Images in replies

pi can show an image in the conversation with its `show_image` tool: give it the path of a PNG, JPEG, GIF or WebP file (up to 2 MB, checked by content, not extension). The app shows it as a figure in the reply. Images load by reference: messages and history carry only a reference, and the app fetches the bytes when the figure scrolls into view. The `show-image` skill in `bridge/skills` tells pi when to use the tool.

## thatsit.app apps

The `thatsit-app` pi skill builds small PWAs at `<name>.thatsit.app` from the app template and turns later changes into PRs with preview links. See [skills/thatsit-app/README.md](skills/thatsit-app/README.md) for install and usage.

## Notifications

Turn notifications on in settings. A device then gets a push when one of pi-web's headless sessions finishes a run with no app open on it, waits on a dialog, or stops with an error. Tapping the notification opens the session. Terminal sessions don't notify, because you are at the terminal.

On iPhone or iPad, add pi-web to the Home Screen first (Share → Add to Home Screen) and turn notifications on from the installed app. Safari tabs can't receive push.

The hub keeps its push keys in `~/.config/pi-web/vapid.json` and the subscribed devices in `~/.config/pi-web/push.json`. Deleting `vapid.json` makes new keys. Each device then re-subscribes the next time it opens pi-web.

## Watch

The hub has an API for a Pebble watch: it lists the dialogs, finished runs and errors the watch may show, takes answers and prompts, and receives voice notes from an Index 01 ring. It is open to anything on the tailnet logged in as you, with no extra token, so the face, the app and the ring need only the hub's address. See [docs/watch-api.md](docs/watch-api.md) for the routes and curl examples, and the [design spec](docs/superpowers/specs/2026-10-16-pebble-watch-design.md) for the plan.

The watch side is in `watch/`: two Pebble Alloy projects for the Pebble Time 2 (emery) and Round 2 (gabbro), each with a phone-side PebbleKit JS bridge to the hub. `watch/app/` is the watchapp (dialogs, finished turns, sessions, history, dictation). `watch/face/` is the watchface: the time and four corners, a sheet that rises when a request is pending, and a wrist flick that opens the app. [watch/README.md](watch/README.md) covers the toolchain, the emulator dev loop against a stub hub or the real hub, the Pebble app setup (the hub URL is entered in both apps' settings pages), the hardware checklist and the known issues.

## Deploy

The app is a Cloudflare Pages project (`pi-web`) connected to this repo. A push
to `master` builds `npm run build -w app` (Node 24) and publishes `app/dist` to
https://pi.thatsit.app; other branches get preview deployments.

Starting a new session with a preselected model is not in Plan 1: start the
session, then switch via the model sheet.

The hub runs as a systemd user unit, exposed on the tailnet by `tailscale serve`:

```bash
npm install                     # once, and after pulling new dependencies
systemctl --user link ~/workspace/pi-web/deploy/pi-web-hub.service
systemctl --user enable --now pi-web-hub.service
sudo loginctl enable-linger $USER   # keep it running without a login session
tailscale serve --bg --https=7878 http://127.0.0.1:7878
```

After pulling hub changes, `systemctl --user restart pi-web-hub`. Restarting
closes any running app-started pi sessions (their history is kept). Logs:
`journalctl --user -u pi-web-hub`.
