# @pi-web/superpowers

pi extension: a per-chat switch for [superpowers](https://github.com/obra/superpowers). Off by default, so its
skills are manual (`/skill:<name>`) until a chat turns them on from the ＋ menu's **superpowers** switch in pi-web.

- `settings.json` loads the superpowers package with `"skills": []` and `"extensions": []`, and this package after it.
- At resource discovery the extension writes copies of the superpowers skills to `~/.pi/agent/tmp/superpowers-manual/`
  with `disable-model-invocation: true` (other files are symlinks to the originals). pi registers them as
  `/skill:<name>` commands and leaves them out of the system prompt, so a chat that never turns the switch on pays
  nothing for them.
- Left out entirely (`EXCLUDED`): `using-git-worktrees` (moves app edits out of `~/workspace/apps`, so the guard
  stops seeing them), `finishing-a-development-branch` (pushes and merges; the thatsit-app flow opens PRs),
  `subagent-driven-development` and `requesting-code-review` (unscoped reviewers next to the guard's).
- `/superpowers on|off` (what the switch sends) saves the state as a `pi-web-superpowers` session entry and shows
  `superpowers on` as the session status, which the app reads back. A resumed chat restores it.
- On: every request carries the using-superpowers bootstrap (as the package's own extension sends it, with the pi
  tool mapping) plus the list of skills with their paths. pi omits manual skills from the system prompt, and a
  mid-chat system prompt change did not reach flash-next reliably, so the list rides in that message.

Checked live over RPC (flash-next, 2026-11-10): off, "which skill first for a new feature?" gets `thatsit-app`;
after the switch, `brainstorming` with its manual copy's path.
