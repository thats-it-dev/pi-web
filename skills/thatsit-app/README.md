# thatsit-app skill

A pi skill that turns "build me an app that does X" into a live PWA at `https://<name>.thatsit.app`, and "change Y" into a pull request with a preview link. `SKILL.md` is what pi reads; this file is for people.

## What it does

- **New app:** pi picks a name and asks you to confirm it. The CLI checks the name is free (GitHub repo, Pages project, DNS record), creates the public repo `thats-it-dev/<name>` from `thats-it-dev/app-template`, clones it to `~/workspace/apps/<name>`, writes `app.config.json` and the icons, and creates the Cloudflare Pages project, the custom domain and the proxied CNAME. pi then writes the app (single-page layout, kit components and tokens only), runs the tests and ships: one push to `main`, then the CLI waits for the production deploy and for the domain to answer.
- **Change:** pi works on a branch and runs `pr`. The CLI runs the checks, pushes, opens or reuses the PR, waits for CI and prints the preview link from the sticky PR comment. pi never merges and never pushes `main` after the first version.

## CLI

```
node scripts/thatsit-app.ts check <name>
node scripts/thatsit-app.ts new <name> --title "..." --description "..." [--color "#RRGGBB"] [--resume]
node scripts/thatsit-app.ts ship <dir>
node scripts/thatsit-app.ts pr <dir> --title "..." --body "..."
```

Each command ends with one `RESULT <json>` line. Exit 0 is success, 1 a failure (the reason is on stderr and in `RESULT`), 2 a usage error. `new --resume` finishes a half-done `new` without creating duplicates. It uses the existing `gh` and `cf` logins on the spark and never handles tokens itself; deploys use the org secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. `THATSIT_APPS_DIR` overrides `~/workspace/apps`.

## Install

pi loads skills from `~/.pi/agent/skills`, and `SKILL.md` calls the CLI by that path:

```bash
ln -s ~/workspace/pi-web/skills/thatsit-app ~/.pi/agent/skills/thatsit-app
```

To try it without installing: `pi --skill ~/workspace/pi-web/skills/thatsit-app`. The CLI paths in `SKILL.md` still point at `~/.pi/agent/skills`, so install before real use.

## Develop

```bash
npm test -w skills/thatsit-app       # unit tests with stubbed gh/cf, plus a SKILL.md check
npm run typecheck -w skills/thatsit-app
```
