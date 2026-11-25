# @pi-web/superpowers

pi extension: a per-chat switch over a vendored, pi-patched subset of [superpowers](https://github.com/obra/superpowers)'
skills. Off by default everywhere; the skills are manual (`/skill:<name>`) until a chat turns the switch on from the
＋ menu in pi-web.

- The skills live in `skills/` here: `brainstorming`, `writing-plans`, `executing-plans`, `systematic-debugging`,
  `test-driven-development`. They are copies of superpowers v7.0.2 with pi's changes applied in the files themselves:
  no `superpowers:` prefixes, no routes to the skills that are not here (subagent-driven-development, worktrees,
  finishing-a-development-branch, requesting-code-review, verification-before-completion), writing-plans hands off
  to executing-plans without asking which approach to use, brainstorming is "use when design questions are open"
  rather than "you MUST", and executing-plans is a short pi-native skill (branch, TDD, tick the plan, thatsit-app
  review and pr, Michael merges). The raw `obra/superpowers` checkout is not installed, so nothing left out can be
  found on disk (2026-11-25).
- At resource discovery the extension writes copies of these skills to `~/.pi/agent/tmp/superpowers-manual/` with
  `disable-model-invocation: true` (other files are symlinks). pi registers them as `/skill:<name>` commands and
  leaves them out of the system prompt, so a chat with the switch off pays nothing for them.
- `/superpowers on|off` (what the switch sends) saves the state as a `pi-web-superpowers` session entry and shows
  `superpowers on` as the session status, which the app reads back. A resumed chat restores it.
- On: a short catalog (one line per skill: name, description, path; under 1.2k chars) rides with every request, after
  any compaction summary, so the model can read one when it clearly applies. There is no using-superpowers bootstrap
  and no mandatory workflow; the old ~6k-char bootstrap on every request, and the default-on for code sessions, went
  on 2026-11-25 after the website session (brainstorming turned "keep the look" into a menu; the excluded skills were
  loaded from the raw checkout anyway).
- On also sets flash-auto's reasoning floor to medium for the chat (`flash-auto-floor` entry); off clears it.

Orchestrator mode: with `subagents.orchestrate: true` in `~/.pi/agent/settings.json` (or, with no flag, the agent
pair as the model), the pi note on `writing-plans` (parallel groups) and `executing-plans` (scout, brief a `worker`
per task, gate on verify and the reviewer, never edit app code; the guard enforces that part) replaces the inline
wording. Read at resource discovery, so a new pi session picks a change up; no hub restart.

Updating the vendored skills: copy the skill dirs from a superpowers checkout over `skills/`, re-apply the patches
above (the test "the vendored skills" fails on a missed one), and keep `executing-plans/SKILL.md` as it is.
