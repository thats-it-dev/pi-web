---
name: thatsit-app
description: Use when Michael asks to build, deploy or change a small web app or PWA on thatsit.app or at <name>.thatsit.app ("build me an app that...", "make a little tool for...", "change X in the <name> app"). Creates the repo from the template, ships the first version, and turns later changes into a PR with a preview link.
---

# thatsit.app apps

Every app is a public repo `thats-it-dev/<name>` made from the app template, checked out at
`~/workspace/apps/<name>`, and served at `https://<name>.thatsit.app`. All GitHub and
Cloudflare work goes through one CLI. Do not run `gh repo create`, `cf` or `wrangler` yourself.

The CLI prints progress, then one last line `RESULT {...json...}`. Exit 0 means done; exit 1
means failed, and the reason is on stderr and in `RESULT`; exit 2 means you typed the command
wrong. `ship`, `pr` and `gateway-pr` wait for CI and can take 20 minutes or more: if your bash
tool takes a timeout, give it 2400 seconds. Copy URLs from `RESULT` into your reply exactly.
Never guess a URL. Each bash call starts in the session folder, so a `cd` does not carry over:
start every app command with `cd ~/workspace/apps/<name> &&` and edit files by full path.

## New app

1. **Name.** Pick a short name: lowercase letters, digits and `-`, starting with a letter, not
   ending with `-`, at most 30 characters. Never use `pi`, `kit`, `www`, `app`, `api`, `mail`
   or `app-template`. Ask Michael in one line, then stop and wait for his answer:
   `I'll call it <name>, at https://<name>.thatsit.app. OK?`
2. **Check.** Run `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts check <name>`.
   If exit 1 says `invalid name`, `reserved name` or `... exists`, pick another name and go
   back to step 1. Any other exit 1 (for example `gh ... failed` or `cf ... failed`): stop and
   tell Michael, quoting the stderr line.
3. **Create.** Run:
   `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts new <name> --title "<Title>" --description "<one sentence>"`
   Add `--color "#RRGGBB"` only if Michael asked for an icon color; that is the only place a
   hex color is allowed. On success `RESULT` has `dir` and `url`. On exit 1, see "When something fails".
4. **Write the app** in `~/workspace/apps/<name>` (full paths below):
   - Remove `data-shell` from the `<html>` tag in `~/workspace/apps/<name>/index.html`.
   - Replace all of `~/workspace/apps/<name>/src/app-main.ts` (start from the skeleton below).
     Extra modules go in new files under `src/`; unit tests for plain logic go in `test/`.
   - Run `cd ~/workspace/apps/<name> && rm e2e/starter.spec.ts`. Keep `e2e/app.spec.ts`.
   - Add `~/workspace/apps/<name>/e2e/<name>.spec.ts` that tests the app's main behavior (example below).
   - Only an app with several pages and a menu keeps `data-shell` and the shell.
5. **Test.** Run `cd ~/workspace/apps/<name> && npm run typecheck && npm test && npm run e2e`; fix and rerun until all three pass.
6. **Commit.** `cd ~/workspace/apps/<name> && git add -A && git commit -m "First version of <name>"`
7. **Ship.** Run `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts ship ~/workspace/apps/<name>`
8. **Reply.** If `RESULT` has `"pending":false`, give Michael its `url`. If `"pending":true`, say
   the custom domain is still validating, give the `url` from `RESULT` (a pages.dev link) and
   say `https://<name>.thatsit.app` will work soon.

If `ship` says `is already shipped`, use **Change**. Spark data: see **Needs spark data**.

## Change an existing app

1. `cd ~/workspace/apps/<name> && git switch main && git pull`
2. `cd ~/workspace/apps/<name> && git switch -c <short-branch>` (e.g. `dark-mode-toggle`). Create the branch (step 2) before editing any file.
3. Edit files by full path, update or add the e2e test, then run
   `cd ~/workspace/apps/<name> && npm run typecheck && npm test && npm run e2e` until green.
4. `cd ~/workspace/apps/<name> && git add -A && git commit -m "<what changed>"`
5. Run `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/<name> --title "<short title>" --body "<what and why>"`
6. Reply with the `pr` and `preview` URLs from `RESULT`.
Never merge a PR (`gh pr merge`) or push to `main` after the first version.

## Needs spark data

Only for an app that reads the spark (models, GPU, pi sessions) or keeps data there; it works
only on Michael's tailnet. Read "Spark gateway" in `~/.pi/agent/skills/thatsit-app/README.md` first.
- App: set `"gateway": true` in `app.config.json`, use `kv` / `system` from `src/gateway.ts`,
  render `<tk-tailnet-only>` on `OffTailnetError`, stub the gateway in e2e with `page.route`.
- Gateway checkout `~/workspace/apps/spark-gateway`, before the app's `ship` or `pr`:
  `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts gateway-checkout`
  `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts gateway-register <name>` (if not in `apps.json`; makes a branch)
  Only if `/system/models|gpu|sessions` and the store are not enough: on a branch, write
  `apps/<name>/routes.ts` + `routes.test.ts` following that repo's `apps/README.md`, commit.
  `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts gateway-pr ~/workspace/apps/spark-gateway --title "..." --body "..."`
- For an app change, add `--gateway-pr <N>` (`number` from `gateway-pr`) to the app's `pr`. Reply
  with every `pr` and `preview` URL from the `RESULT`s; the app works for real once Michael merges
  the gateway PR. Never edit the gateway's `src/`, never merge, never touch `~/.local/share/spark-gateway`.

## Skeleton: single-page `src/app-main.ts`

```ts
import { LitElement, html, css } from "https://kit.thatsit.app/lit.js";
import { sharedStyles, toast } from "https://kit.thatsit.app/kit.js";

export class AppMain extends LitElement {
	static properties = { count: { state: true } };
	// Layout only here: no colors, fonts or border-radius. Never override createRenderRoot.
	static styles = [sharedStyles, css`
		main { display: grid; gap: 14px; padding: 18px; max-width: 40rem; margin: 0 auto; }
		.row { display: flex; gap: 10px; flex-wrap: wrap; }
	`];
	count = 0;
	render() {
		return html`
			<main>
				<h1>${__APP_TITLE__}</h1>
				<p><span class="label">count</span> ${this.count}</p>
				<div class="row">
					<button class="btn" @click=${() => this.count++}>Add one</button>
					<button class="btn ghost" @click=${() => { this.count = 0; toast("Reset"); }}>Reset</button>
				</div>
			</main>
			<tk-toasts></tk-toasts>
		`;
	}
}
customElements.define("app-main", AppMain);
```

## Example `e2e/<name>.spec.ts`

```ts
import { expect, test } from "./csp.ts";

test("add one increases the count", async ({ page }) => {
	await page.goto("/");
	await page.locator(".btn", { hasText: "Add one" }).click();
	await expect(page.locator("main")).toContainText("count 1");
});
```

## Style rules

- Import Lit only from `https://kit.thatsit.app/lit.js` and the kit only from
  `https://kit.thatsit.app/kit.js`. Never `from "lit"`. Reference: https://kit.thatsit.app/ (live
  demo) and https://kit.thatsit.app/kit.d.ts.
- Use only kit components: `tk-sheet` (`heading`, `.open`, `@tk-close`), `tk-toasts` (shows
  `toast("msg")`), `tk-shell` + `tk-header` for nav apps, and `tk-tailnet-only` for gateway apps.
- Use only `sharedStyles` classes: `.btn`, `.btn.ghost`, `.seg` (button group, `.on` for the
  selected one), `.u` (underlined link, `.on`), `.label`, `.dot`, and plain `input`, `textarea`, `select`.
- Colors and fonts come only from tokens such as `var(--bg)`, `var(--text-primary)`, `var(--text-muted)`,
  `var(--primary)`, `var(--accent)`, `var(--border-color)`, `var(--radius)`. No hex colors,
  `font-family` or `border-radius` values in app code.

## When something fails

- `new --resume` failed (any error): keep the name, fix the cause, rerun with `--resume`.
- `new` failed (without `--resume`): if the error starts with `invalid name`, `reserved name`,
  `color must`, `GitHub repo exists`, `Pages project exists`, `DNS record exists`, `gh repo view`,
  `cf pages get`, `cf dns records list`, `gh repo create` or `could not read the GitHub account
  identity`, or ends in `already exists`, nothing was created: fix it and rerun without `--resume`
  (a name problem means a new name, back to step 1). Any other error came after the repo was made:
  from then on use `--resume` with the same name and never pick a new one. Fix the cause and rerun
  the same command with `--resume`; if it fails twice, stop and tell Michael.
- `npm ... failed; fix it before pushing`: the CLI ran the tests for you. Fix, commit, rerun the same command.
- `deploy run ... failed in` / `test run ... failed in` / `spark preview ... failed`: the error ends
  with the last lines of the failing tests. Fix that, commit, and rerun the same `ship`, `pr` or
  `gateway-pr`. A rerun of `pr` or `gateway-pr` updates the same PR and its preview comment.
- `deploy step was skipped`: the org secrets or `app.config.json` need Michael. Stop and tell him; do not rerun.
- `did not finish within`, `did not report a preview` or `No preview`: give Michael the URL from
  the error and stop; do not push again.
- `there are uncommitted changes`: run `cd ~/workspace/apps/<name> && git add -A && git commit -m "..."`, then rerun.
- `pr will not run on main` / `gateway-pr will not run on main`: create a branch first (Change step 2).
- `ship only works on the main branch`: run `cd ~/workspace/apps/<name> && git switch main`, then rerun.
- Stop and tell Michael (quote the reason from `RESULT`) when the same command fails with exit 1
  twice and you can't fix it, or when the error mentions login, permissions, secrets or a token.
- Never print, ask for, or write tokens or secrets. The CLI uses the existing `gh` and `cf` logins.
