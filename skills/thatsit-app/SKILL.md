---
name: thatsit-app
description: Use when Michael asks to build, deploy or change a small web app or PWA on thatsit.app or at <name>.thatsit.app ("build me an app that...", "make a little tool for...", "change X in the <name> app"). Creates the repo from the template, ships the first version, and turns later changes into a PR with a preview link.
---

# thatsit.app apps

Every app is a public repo `thats-it-dev/<name>` made from the app template, checked
out at `~/workspace/apps/<name>`, and served at `https://<name>.thatsit.app`.
All GitHub and Cloudflare work goes through one CLI. Do not run `gh repo create`,
`cf` or `wrangler` yourself.

The CLI prints progress, then one last line `RESULT {...json...}`.
Exit 0 means done; exit 1 means failed, and the reason is on stderr and in `RESULT`;
exit 2 means you typed the command wrong. `ship` and `pr` wait for CI and can take
20 minutes or more: if your bash tool takes a timeout, give it 2400 seconds.
Copy URLs from `RESULT` into your reply exactly. Never guess a URL.
Each bash call starts in the session folder, so a `cd` does not carry over: start
every app command with `cd ~/workspace/apps/<name> &&` and edit files by full path.

## New app

1. **Name.** Pick a short name: lowercase letters, digits and `-`, starting with a
   letter, not ending with `-`, at most 30 characters. Never use `pi`, `kit`, `www`,
   `app`, `api`, `mail` or `app-template`. Ask Michael in one line, then stop and wait for his answer:
   `I'll call it <name>, at https://<name>.thatsit.app. OK?`
2. **Check.** Run:
   `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts check <name>`
   If exit 1 says `invalid name`, `reserved name` or `... exists`, pick another name
   and go back to step 1. Any other exit 1 (for example `gh ... failed` or
   `cf ... failed`): stop and tell Michael, quoting the stderr line.
3. **Create.** Run:
   `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts new <name> --title "<Title>" --description "<one sentence>"`
   Add `--color "#RRGGBB"` only if Michael asked for an icon color; that is the only
   place a hex color is allowed. On success `RESULT` has `dir` and `url`.
   On exit 1, see "When something fails" for whether to rerun with `--resume`.
4. **Write the app** in `~/workspace/apps/<name>` (full paths below):
   - Remove `data-shell` from the `<html>` tag in `~/workspace/apps/<name>/index.html`.
   - Replace all of `~/workspace/apps/<name>/src/app-main.ts` (start from the
     skeleton below). Extra modules go in new files under `src/`; unit tests for
     plain logic go in `test/`.
   - Run `cd ~/workspace/apps/<name> && rm e2e/starter.spec.ts`. Keep `e2e/app.spec.ts`.
   - Add `~/workspace/apps/<name>/e2e/<name>.spec.ts` that tests the app's main
     behavior (example below).
   - Only an app with several pages and a menu keeps `data-shell` and the shell.
5. **Test.** Run `cd ~/workspace/apps/<name> && npm run typecheck && npm test && npm run e2e`.
   Fix and rerun until all three pass.
6. **Commit.** `cd ~/workspace/apps/<name> && git add -A && git commit -m "First version of <name>"`
7. **Ship.** Run:
   `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts ship ~/workspace/apps/<name>`
8. **Reply.** If `RESULT` has `"pending":false`, give Michael its `url`. If
   `"pending":true`, say the custom domain is still validating, give the `url` from
   `RESULT` (a pages.dev link) and say `https://<name>.thatsit.app` will work soon.

`ship` works once per app. If it says the app `is already shipped`, use **Change**.

## Change an existing app

1. `cd ~/workspace/apps/<name> && git switch main && git pull`
2. `cd ~/workspace/apps/<name> && git switch -c <short-branch>` (e.g. `dark-mode-toggle`).
3. Edit files by full path, update or add the e2e test, then run
   `cd ~/workspace/apps/<name> && npm run typecheck && npm test && npm run e2e` until green.
4. `cd ~/workspace/apps/<name> && git add -A && git commit -m "<what changed>"`
5. Run:
   `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/<name> --title "<short title>" --body "<what and why>"`
6. Reply with the `pr` and `preview` URLs from `RESULT`.

Never merge a PR, never run `gh pr merge`, never push to `main` after the first
version. Michael merges.

## Skeleton: single-page `src/app-main.ts`

```ts
import { LitElement, html, css } from "https://kit.thatsit.app/lit.js";
import { sharedStyles, toast } from "https://kit.thatsit.app/kit.js";

export class AppMain extends LitElement {
	static properties = { count: { state: true } };
	// Layout only here: no colors, fonts or border-radius.
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

Render into the shadow root as above: never override `createRenderRoot`.

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
  `https://kit.thatsit.app/kit.js`. Never `from "lit"`.
- Use only kit components: `tk-sheet` (`heading`, `.open`, `@tk-close`),
  `tk-toasts` (shows `toast("msg")`), and `tk-shell` + `tk-header` for nav apps.
- Use only `sharedStyles` classes: `.btn`, `.btn.ghost`, `.seg` (button group, `.on`
  for the selected one), `.u` (underlined link, `.on`), `.label`, `.dot`, and plain
  `input`, `textarea`, `select`.
- Colors and fonts come only from tokens such as `var(--bg)`, `var(--text-primary)`,
  `var(--text-muted)`, `var(--primary)`, `var(--accent)`, `var(--border-color)`,
  `var(--radius)`. No hex colors, `font-family` or `border-radius` values in app code.
- Reference: https://kit.thatsit.app/ (live demo) and https://kit.thatsit.app/kit.d.ts.

## When something fails

- `new` failed: if the error starts with `invalid name`, `reserved name`, `color must`,
  `GitHub repo exists`, `Pages project exists`, `DNS record exists`, `gh repo view`,
  `cf pages get`, `cf dns records list` or `gh repo create`, or ends in `already exists`,
  nothing was created: fix it and rerun without `--resume` (a name problem means a new
  name, back to step 1). Any other error came after the repo was made: fix the cause
  and rerun the same command with `--resume` added.
- `npm ... failed; fix it before pushing`: the CLI ran the tests for you. Fix, commit,
  rerun the same command.
- `deploy run ... failed in`: the error ends with the last lines of the failing CI step.
  Fix that, commit, and rerun the same `ship` or `pr`. A rerun of `pr` updates the same
  PR and its preview comment.
- `deploy step was skipped`: the org secrets or `app.config.json` need Michael. Stop and
  tell him; do not rerun.
- `did not finish within`: CI is slow or stuck. Give Michael the run URL from the error
  and stop; do not push again.
- `there are uncommitted changes`: run `cd ~/workspace/apps/<name> && git add -A && git commit -m "..."`, then rerun.
- `pr will not run on main`: do Change step 2 first.
- `ship only works on the main branch`: run `cd ~/workspace/apps/<name> && git switch main`, then rerun.
- Stop and tell Michael (quote the reason from `RESULT`) when the same command fails
  with exit 1 twice and you can't fix it, or when the error mentions login,
  permissions, secrets or a token.
- Never print, ask for, or write tokens or secrets. The CLI uses the existing `gh`
  and `cf` logins.
