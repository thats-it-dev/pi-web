# Progress panel: goal, plan, to-dos and subagent threads

Date: 2026-11-08 · Branch: `feat/progress-panel` (worktree `~/workspace/pi-web-progress-panel`, from `origin/master` 9e67616)

## Why

Michael runs long agent sessions in pi-web and wants to **glance mid-run** at where things stand (what the goal is, which plan step it's on, which to-do is in progress, what subagents are doing) without scrolling back through the chat. He uses pi-web on desktop and phone about equally, so both must feel first-class.

Today pi-web has a left session sidebar and the chat. It renders `todo`, `subagent` and goal tool calls as ordinary tool rows. pi's TUI has its own overlays for these (rpiv-todo panel, pi-subagents FleetView), but pi-web has nothing equivalent.

## Goals

1. **A right-hand progress column on desktop**, beside the chat, with up to four sections. Each section appears only when the session has that kind of data:
   - **Goal:** the pi-goal objective text and its status (active, paused, blocked, waiting, budget-limited, complete).
   - **Plan:** the plan document the agent is working from. A compact list of its tasks (the `### Task N` headings), each with its ticked/total checkbox count. The current task is the first one with unticked boxes, and it's highlighted. A link opens the full document.
   - **To-dos:** the rpiv-todo list with a `done/total` count, the in-progress item highlighted (using its `activeForm` label), and completed items struck through.
   - **Subagents:** one row per child: agent name, task (truncated), state (running / done / failed / stopped) and elapsed time. It lists the children from the current or latest turn, plus any background children still running. Older children fold into an "Earlier (n)" group, newest first.
2. **On the phone:** a small progress badge in the session header (e.g. `3/7`, the to-do count; if there are no to-dos, some other compact indicator for goal/plan/subagents). Tapping it, or swiping in from the right edge, opens a **full-screen progress view** with the same sections and a close control.
3. **Read-only subagent threads.** Selecting a subagent opens its thread: its task, its messages and tool calls (live while it runs), status, and final result.
   - **Desktop:** the thread **takes over the main chat area**, with a breadcrumb (`<parent session> › <agent> · <task>`), a "read-only" marker and a way back to the parent. The right column stays visible, so you can hop between children; the selected child is marked there. The composer is replaced by a "viewing a subagent · back to parent" bar.
   - **Phone:** tapping a subagent in the progress view pushes the thread full-screen with a back arrow.
4. **Live and correct.** Everything updates as the run streams, and finished things show as finished.

## Non-goals

- Steering, stopping or messaging subagents. Threads are read-only.
- Editing to-dos, the plan or the goal from the panel.
- Changing pi or its extensions. The panel reads what sessions already record, plus files on disk.
- The Pebble watch UI.

## Anti-goals (fail even if it "works")

- **Stale or wrong status.** A to-do shown in progress, or a subagent shown running, after it has actually finished, failed, been aborted, or the turn ended. This includes after reconnect or reload, and for runs that died without a clean end event. When state is genuinely unknown, show that rather than "running".
- **Showing "running" when it isn't, or hiding work that is.** Show each item's real state. A background subagent that is still running after the parent's turn ends *is* running: read its state from the async run's `status.json` (and its events), not from the turn's event stream. A to-do left `in_progress` because the agent stopped to ask Michael something stays in progress, but the panel makes it clear the agent is idle or waiting on him.
- **Looks bolted on.** It must match pi-web: the Nunito theme and tokens in `theme/theme.css`, the same visual language as `pi-sidebar.ts`, light and dark modes. It should look like it was always part of the app.

## Where the data comes from (findings from recon, 2026-11-08)

- **To-dos (`@juicesharp/rpiv-todo` 2.12.0):** every `todo` toolResult carries the full post-mutation list in `details.tasks`: `[{id, subject, status, description, activeForm, blockedBy?}]`. The current list is the `details.tasks` from the latest `todo` result on the session branch. Rebuild it from the conversation, the same way the extension does. Example: `~/.pi/agent/sessions/--home-michael--/2026-11-03T02-12-06-379Z_01a19f2d-…jsonl`. rpiv-todo drops completed rows at the start of the next turn in the TUI. Whether pi-web mirrors that is the builder's call (see below).
- **Subagents (`pi-subagents` 0.76.0):** the `subagent` tool's `details` (type `Details` in `src/shared/types.d.ts`) has `results: SingleResult[]`. Each has `agent`, `task`, `sessionName`, `exitCode`, `interrupted/timedOut/stopped/detached`, `progress`, `toolCalls`, `messages?`, `finalOutput`, `model`, `usage` and **`sessionFile`** (the child's own pi session). Background runs also have `details.asyncDir` / `asyncId`, with `events.jsonl`, `status.json` (`state`, `sessionFile`, …) and a transcript under the async dir (`docs/observability.md`). Foreground children stream through `tool_execution_update` partial results, which `shared/src/reducer.ts` already keeps as `partialResult`. Only one existing session has used `subagent`, and its result had empty details, so **confirm these shapes against a real run** before relying on them.
- **Goal (`@narumitw/pi-goal` 0.54.8):** the goal is persisted in the session (custom message/entries, see `src/goal-contract.ts` and `src/runtime.ts`), with explicit `goal_complete` / `goal_blocked` / `goal_wait` tool calls. No existing session uses it yet, so derive the record format from the source and a test run.
- **Plan document:** there's no standard plan record. Identify the plan as a markdown plan file the agent has read or edited in this session, primarily `docs/superpowers/plans/*.md` (superpowers' writing-plans format: `### Task N` headings with `- [ ] **Step …**` checkboxes). Read it from disk through the hub, relative to the session cwd, and re-read it when the agent edits it. Plannotator's browser-based plan review is out of scope as a source.
  - **Problem found in the builder check:** agents don't tick these boxes today. All 16 plans in this repo have 30–95 boxes and zero `- [x]`. Michael's call is to **make agents tick them**. So this build also adds a global pi instruction (e.g. `~/.pi/agent/AGENTS.md`, or whatever global-instructions mechanism pi supports; verify it) that says: when executing a plan file, change each step's `- [ ]` to `- [x]` as soon as that step is done, before moving on. Verify it with a real pi run on the spark's default model (flash-auto) before relying on it. If ticking proves unreliable, raise it with Michael rather than silently guessing at the current step.

## Decided

- Right-hand column on desktop. Header badge plus full-screen view (swipe-in from the right as well) on the phone. (Michael)
- All four sections, each shown only when present. (Michael)
- Subagent threads are read-only, open in the main chat area on desktop, and are pushed full-screen on the phone. (Michael)
- Agents tick plan checkboxes as they go, and the current task comes from the ticks. (Michael)
- Subagents section: recent + still-running children, with older ones under "Earlier (n)". (Michael)
- Plan steps are shown at the `### Task N` level with box counts, not as individual checkboxes. (my call)
- Background children show their live state from the async run's status files. A to-do left in progress at turn end stays in progress, with an "agent idle / waiting on you" cue. (my call)
- Show the `subject`/`activeForm` text of to-dos, with no descriptions in the compact view. (my call)

## Left to the builder

- How the hub serves the panel's data (derive it client-side in the reducer from the event stream, add a hub endpoint, or both), and how a child session's transcript is read (it can live outside the indexed sessions dirs, so the hub needs to allow those paths safely; child sessions should not clutter the left sidebar).
- At what width the desktop column collapses to the phone pattern, and whether the desktop column can be hidden. It shouldn't crowd the chat on a laptop.
- How the overflow is handled for long to-do lists, plans and many subagents.
- Whether completed to-dos clear at the next turn, as in the TUI, or persist until the list is replaced.
- What the phone badge shows when there are no to-dos.
- How "elapsed" is computed, and how a child that died without a terminal event is detected and shown.
- Plan-file heuristics beyond `docs/superpowers/plans/`. Keep them conservative: a wrong "plan" is worse than none.
