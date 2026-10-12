# pi, that's it.

A PWA for the [pi](https://pi.dev) coding agent running on spark: browse every
session (CLI or app), continue them with live streaming, start new ones, switch
models and thinking levels, watch context usage, and use slash commands. Styled
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
  "piBin": "pi"
}
```

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

## Notifications

Turn notifications on in settings. A device then gets a push when one of pi-web's headless sessions finishes a run with no app open on it, waits on a dialog, or stops with an error. Tapping the notification opens the session. Terminal sessions don't notify, because you are at the terminal.

On iPhone or iPad, add pi-web to the Home Screen first (Share → Add to Home Screen) and turn notifications on from the installed app. Safari tabs can't receive push.

The hub keeps its push keys in `~/.config/pi-web/vapid.json` and the subscribed devices in `~/.config/pi-web/push.json`. Deleting `vapid.json` makes new keys. Each device then re-subscribes the next time it opens pi-web.

## Deploy

The app is a Cloudflare Pages project (`pi-web`) connected to this repo. A push
to `master` builds `npm run build -w app` (Node 24) and publishes `app/dist` to
https://pi.thatsit.app; other branches get preview deployments.

Starting a new session with a preselected model is not in Plan 1: start the
session, then switch via the model sheet.

Hub deployment (tailscale serve, systemd) is Plan 4.
