# pi, that's it.

A PWA for the [pi](https://pi.dev) coding agent running on spark: browse every
session (CLI or app), continue them with live streaming, start new ones, switch
models and thinking levels, watch context usage, and use slash commands. Styled
after thatsit.dev.

- `hub/`: Node server on spark. Runs one headless `pi --mode rpc` per open
  session, serves REST + SSE, accepts only your Tailscale identity from the
  app's origin. Zero runtime dependencies; runs `.ts` directly on Node ≥ 22.18.
- `app/`: Vite + Lit PWA (static; deploys to pi.thatsit.dev).
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
npm test              # shared + hub (node:test, real pi against a fake model) + app (vitest)
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
  "allowedOrigins": ["https://pi.thatsit.dev"],
  "idleMinutes": 20,
  "maxHeadless": 6,
  "piBin": "pi"
}
```

Starting a new session with a preselected model is not in Plan 1: start the
session, then switch via the model sheet.

Deployment (tailscale serve, Netlify, systemd), terminal sync (the bridge
extension) and push notifications are Plans 2–4.
