# Preview Panel, Plan 4 of 4: Teaching pi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi opens a live preview as the default step after the first visual change and before any UI PR, uses it for mockups and prototypes, and is nudged (never blocked) when it skips it.

**Architecture:** Three places pi learns from, each changed once: the thatsit-app skill's "look" and "pr" steps, the standing rules in `~/.pi/agent/AGENTS.md` (outside the repo), and a guard note attached to the screenshot and `pr` command results when no `preview` call exists in the session branch. The guard change is a pure rule (`previewOpened`, `previewNote`) plus one hook-up in `index.ts`, tested like the other notes.

**Tech Stack:** Markdown, TypeScript, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-23-preview-panel-design.md` (section "Teaching pi", "Agent habit").

**Depends on:** plan 2 (the `preview` tool exists; its skill is `bridge/skills/preview/SKILL.md`).

## Global Constraints

- The nudge is a note on a tool result, never a `{ block: true }`; one per session.
- Never nudge in a subagent child (`PI_SUBAGENT_CHILD`), like the other nudges.
- The skill stays Michael's prompting style: short imperative lines, user's-eye ("Michael looks"), no diagnosis.
- `~/.pi/agent/AGENTS.md` is edited in place and is not in any repo; the plan records the exact text.

## Review Focus

1. A docs-only change (design doc, plan) followed by `pr`: no preview note. Test in Task 1 (`uiChanged` false → no note).
2. The orchestrator in the pair never edits files, so "UI changed" must come from git (`uiChanged(dir)`), not from edit tool calls. Covered by using `uiChanged` in Task 1.
3. A session that called `preview` for a different app than the one being PR'd: still counts as "no preview for this app". Test in Task 1 (`previewOpened` scoped by dir).
4. After a compaction the branch still holds the `preview` toolCall (notes read the branch, not the context). Covered by reading `ctx.sessionManager.getBranch()` in Task 1.
5. The note must not fire twice when both a screenshot and a `pr` run without a preview. Test in Task 1 (flag).

---

### Task 1: Guard rule and note

**Files:**
- Modify: `guard/rules.ts`
- Modify: `guard/index.ts` (the `tool_call` bash branch, near the `screenshotDir` handling)
- Test: `guard/test/rules.test.ts`, `guard/test/index.test.ts`

**Interfaces:**
- Produces (in `rules.ts`):
  ```ts
  /** Whether the branch has a finished, successful `preview` call whose cwd/dir/file resolves under `dir`. */
  export function previewOpened(branch: Iterable<unknown>, dir: string, cwd: string, home: string): boolean;
  export const PREVIEW_NOTE_MARK = "[pi-guard] no live preview ";
  export function previewNote(dir: string): string;
  // `${PREVIEW_NOTE_MARK}for ${dir} this session. Michael can look at the app live in pi-web's Preview panel: call preview({ cwd: "${dir}" }) now, tell him in one line, and end your turn; open the PR after he has looked or waved it off, unless the change isn't visual.`
  export function opensPr(command: string): boolean; // exports the existing OPENS_PR test
  ```
  In `index.ts`: a `let previewNudged = false` beside `briefed`; in the bash branch of `tool_call`, when `!child` and (`screenshotDir(command, ...)` gives an app dir, or `opensPr(command)` and `appDir(command, cwd, home)` gives one), and `uiChanged(dir)` and `!previewOpened(branch(), dir, ctx.cwd, home)` and `!previewNudged`: `previewNudged = true; addNote(event.toolCallId, previewNote(dir))`.

- [ ] **Step 1: Write the failing rule tests** in `guard/test/rules.test.ts`

```ts
test("previewOpened finds a successful preview call for the app and not for another", () => {
	const branch = [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "p1", name: "preview", arguments: { cwd: "~/workspace/apps/fret" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "p1", toolName: "preview", isError: false, details: { url: "https://x:10600", kind: "dev" } } },
	];
	assert.equal(previewOpened(branch, `${HOME}/workspace/apps/fret`, HOME, HOME), true);
	assert.equal(previewOpened(branch, `${HOME}/workspace/apps/keeb`, HOME, HOME), false);
	assert.equal(previewOpened([], `${HOME}/workspace/apps/fret`, HOME, HOME), false);
});
test("an errored or stopped preview does not count", () => { /* isError true → false; details {stopped:true} → false */ });
test("previewNote names the dir and the tool call", () => {
	const n = previewNote("/h/workspace/apps/fret");
	assert.ok(n.startsWith(PREVIEW_NOTE_MARK));
	assert.match(n, /preview\(\{ cwd: "\/h\/workspace\/apps\/fret" \}\)/);
});
```

Use whatever shape the file's other branch fixtures use for entries (the existing tests build `branch` arrays for `reviewedSinceUser`; match them).

- [ ] **Step 2: Write the failing hook tests** in `guard/test/index.test.ts`, with the `load()` helper, a `ctx` that has `sessionManager.getBranch()` returning the branch above, and `uiChanged` stubbed through the existing injection point (the test file already fakes git for `uiChanged`/`screenUpToDate`; follow it):

```ts
test("the screenshot result carries the preview note once, when UI changed and no preview was opened", ...); // tool_call then tool_result for a screenshot command: content ends with previewNote(dir); a second screenshot: no note
test("a pr with UI changes and no preview gets the note; with a preview call in the branch it does not", ...);
test("a docs-only pr gets no preview note", ...); // uiChanged false
test("no preview note in a subagent child", ...); // PI_SUBAGENT_CHILD
```

- [ ] **Step 3: Run** — `cd guard && node --test --test-concurrency=1 test/rules.test.ts test/index.test.ts` → FAIL.
- [ ] **Step 4: Implement** `previewOpened` (walk branch entries; collect `preview` toolCalls by id with their `cwd ?? dir ?? file` resolved with `appDir`-style expansion of `~` against `home` and relative paths against `cwd`; a toolResult for that id with `isError !== true` and `details.url` counts when the resolved path starts with `dir`), `previewNote`, `opensPr`; wire `index.ts`.
- [ ] **Step 5: Run all guard tests** — `npm run test -w guard && npm run typecheck -w guard` → PASS.
- [ ] **Step 6: Commit** — `git commit -m "guard: note on screenshot and pr results when no live preview was opened for the app"`

---

### Task 2: thatsit-app skill

**Files:**
- Modify: `skills/thatsit-app/SKILL.md` ("New app" step 5, "Change an existing app" step 4 and 5)
- Test: `skills/thatsit-app/test/*.test.ts` (there is a skill test workspace; if a test reads SKILL.md sections, keep it green)

- [ ] **Step 1: Edit "New app" step 5.** After the screenshot comparison sentence ("A difference goes back to the worker; verify, look again."), add: `Then let Michael look: call \`preview({ cwd: "~/workspace/apps/<name>" })\`, tell him in one line that the preview is open, and end your turn. Edits live-reload in it; fix what he asks, verify, look again. Go on to Commit when he says it's good or waves it off.`
- [ ] **Step 2: Edit "Change" step 4.** After "A difference goes back to the worker, not to the reviewer." add: `Then open the live preview for Michael (\`preview({ cwd: "~/workspace/apps/<name>" })\`), say so in one line, and end your turn; continue with the review once he has looked or waved it off.` Change the step heading from **Look, then review.** to **Look, show, then review.**
- [ ] **Step 3: Edit "Change" step 5.** Prefix with: `Only after Michael has seen the preview (or said to skip it).`
- [ ] **Step 4: Add a line under "## thatsit.app apps" intro** (after the `cd` sentence): `Mockups and prototypes before code: write the HTML in the folder \`preview({})\` returns, then \`preview({ dir })\`; Michael sees it in pi-web.`
- [ ] **Step 5: Run** — `npm run test -w skills/thatsit-app` → PASS (fix any section-reading test).
- [ ] **Step 6: Commit** — `git commit -m "thatsit-app skill: open a live preview for Michael before review and PR"`

---

### Task 3: Standing rules in `~/.pi/agent/AGENTS.md`

**Files:**
- Modify: `/home/michael/.pi/agent/AGENTS.md` (outside the repo; record the diff in the plan's commit message of Task 4)

- [ ] **Step 1: Edit the "Production is Michael's step" bullet.** Replace its last sentence `Deploy to a preview URL, show it, and ask.` with: `UI work: open a live preview first (the \`preview\` tool), iterate with Michael there, then PR. Deploy to a Pages preview URL, show it, and ask.`
- [ ] **Step 2: Verify** — `grep -n 'preview' ~/.pi/agent/AGENTS.md` shows the new sentence once; the file still has 12 rule lines plus the "Plan files" section.

---

### Task 4: README notes and a pinned-model pi run

**Files:**
- Modify: `bridge/README.md` or `README.md` (whichever documents the bridge's tools; add `preview` beside `show_image`, two lines)
- Modify: `guard/README.md` (one line under notes: the preview note)

- [ ] **Step 1: Document** the tool and the note in the two READMEs.
- [ ] **Step 2: Pinned-model run** (manual; outcome goes in the commit message). In a throwaway branch of `~/workspace/apps/fret` via a headless pi with the model pinned (Michael's rule: never let `pi -p` fall back), prompt in Michael's style: `make the fret dots a touch bigger`. Expected transcript: edit → verify → screenshot → `preview({ cwd })` → one-line reply ending the turn; no `pr` before a second user message. If the guard note fires instead (pi skipped the preview), that is also acceptable evidence that the nudge works; record which happened.
- [ ] **Step 3: Commit** — `git commit -m "docs: preview tool and guard note; AGENTS.md standing rule updated (outside repo)"` with the AGENTS.md diff pasted in the body.

---

## Self-review notes

- Spec coverage: tool description (plan 2 T5), skill `look` step gains "open a preview for Michael" before `pr` and `pr` waits for his look (T2), AGENTS.md rule text as the spec states (T3), guard nudge once per session, never a block, using git-based `uiChanged` (T1), preview skill (plan 2 T6), pinned-model run (T4).
- Names: `previewOpened`, `previewNote`, `PREVIEW_NOTE_MARK`, `opensPr` are new exports of `guard/rules.ts`; nothing else references them.
