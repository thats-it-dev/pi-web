# Progress-panel fixtures: observed shapes

Captured 2026-11-08 from real `pi` 1.0.2 runs (RPC mode, default model spark/flash-auto, scout on
spark/qwen3.8-flash-next) with the user's normal agent dir. Session files are trimmed (system
message entries, `custom_message` entries and `plannotator` custom entries dropped; `thinking` text blanked; strings over 1500 chars clipped; mission paths shortened);
absolute paths rewritten to `/FIXTURE/...`. Ids, timestamps and shapes are real.

## Differences from the plan's expectations (plan Task 2 interfaces updated for these)

1. **Subagent `task` is redacted in results.** `details.results[].task` is the literal string
   `"[prompt redacted]"` (also in `progress[].task`, `status.json`, `mission`). The real task text
   is only in the toolCall arguments: `toolCall.arguments.task`. Use that for `SubagentChild.task`.
2. **A completed goal is immediately followed by a `goal: null` entry.** `goal_complete` writes two
   `goal-state` entries with the same timestamp: `{goal:{...status:"complete"}}` then `{goal:null}`.
   A naive "latest entry wins" gives `null` for a finished goal. `goalFromEntries` must keep the
   complete goal when the `null` immediately follows a `complete` one.
3. **Async is the default** for `subagent`; foreground needs `async:false` in the args (the model
   passes `"async": false`). `subagents_enable` was NOT needed: `subagent` was available at once.
4. `sessionFile` is **absent** in every `tool_execution_update` (see below), present only at the end.
5. While running, `results[0].exitCode` is already `0` (placeholder); it is not evidence of success.
   Running/finished status is in `partialResult.details.progress[].status` (`running` then
   `completed`) and by the existence of `tool_execution_end`.
6. Background `status.json` terminal state for success is `"complete"` (not `"completed"`).

## Questions

### Where are the to-do tasks? (`todo.jsonl`)
`message.role=toolResult`, `toolName:"todo"`, `message.details.tasks[]` = full snapshot after every
action (`{id:number, subject:string, status:"pending"|"in_progress"|"completed"|"deleted"?,
activeForm?:string}`); also `details.action` (`create|update|...`), `details.params`, `details.nextId`.
Each result carries the whole list, so the last `todo` toolResult is the current state.
Tool-call args: `{action:"create", subject, activeForm?}` / `{action:"update", id, status}`.
`deleted` was not produced in the run (it is in the tool's schema/types, not observed).

### Where are the subagent children? (`subagent-fg.jsonl`)
toolResult `toolName:"subagent"`: `message.details.results[]` with `index, agent, task("[prompt
redacted]"), exitCode, sessionName, model, thinking, usage, sessionFile, transcriptPath,
artifactPaths, outputState, finalOutput`. Also `details.runId`, `details.mode:"single"`.
`stopped|interrupted|timedOut` are optional booleans on a result (declared in pi-subagents
`SingleResult` type; not observed because the run succeeded, so they are absent). `isError:false`
on the toolResult. The spawning call is in the assistant message: `content[].type=="toolCall"`,
`name:"subagent"`, `arguments:{agent, task, async}`. One result per child; for single mode
`results.length===1`. Parallel/chain are workflow-script based; a `results[]` per child with `index`.

### Does `tool_execution_update.partialResult.details.results[].sessionFile` exist while running?
**No.** In all 52 updates of `subagent-fg.rpc-events.jsonl`, `results[0]` has no `sessionFile`
(keys: index, agent, task, sessionName, launchContractDigest, launchResolvedExtensions, exitCode,
outputState, usage, model, thinking, artifactPaths, transcriptPath, context, [toolCalls]).
Live info is in `partialResult.details.progress[]`: `{index, agent, sessionName, status:"running"|
"completed", task:"[prompt redacted]", recentTools[], recentOutput[], toolCount, tokens, model,
durationMs, lastActivityAt, turnCount, ...}`. `partialResult.details.runId` is present from the
first update. `artifactPaths.transcriptPath` is present in updates from the first one on.
The final `tool_execution_end.result.details.results[0].sessionFile` is set.
The path is derivable: `<parent session file minus ".jsonl">/<runId>/run-<index>/session.jsonl`.

### Is the child's sessionFile written incrementally?
Yes (inferred from file times, not by tailing during the run): the child file was created at child
start (birth 14:11:24.16 with the header, model_change, session_info, system and user entries) and
gains an entry as each message completes (entry timestamps 22:11:35, :49, 22:12:02 equal the file's
later mtime 14:12:02.76). Messages are appended whole (no `message_update` deltas).
Header (`type:"session"`): `{version:3,id,timestamp,cwd}`; NO `parentSession` field.

### Background: asyncDir / asyncId / status.json
Spawning toolResult (`subagent-bg.jsonl`): `details.asyncId` (= `details.runId`),
`details.asyncDir` (`<tmpdir>/pi-subagents-uid-<uid>/async-subagent-runs/<runId>`),
`details.results` is `[]`, `details.mode:"single"`. Text content begins
`Run fan-out: ...\nAsync: scout [<runId>]`. toolCall args contain `async:true`.
`status.json` (`bg-run/status.json`, taken after completion): `state`, `startedAt`, `endedAt`
(ms epoch; `endedAt` absent while running), `lastUpdate`, `runId`, `mode`, `sessionId` (= parent
session file path), `cwd`, `steps[]` (`agent`, `status`, `sessionFile` of the child, `startedAt`,
`endedAt`, `description:"[prompt redacted]"`), `sessionFile` top-level too, `outputFile`,
`totalTokens`, `turnCount`, `toolCount`. There is no `durationMs`/`asyncDir` field in the file.
Seen states: `running` (during), `complete` (terminal). Per pi-subagents `src/shared/types.d.ts`
(`AsyncStatus.state`): `queued | running | complete | failed | partial | paused | stopped |
rejected`. Terminal: `complete, failed, partial, stopped, rejected`; `paused` is resumable.
Per-step `status` uses the same words (`running`, `complete` ...). (observability.md lists
`completed` for external runs/`ExternalRunState`; the async file uses `complete`.)
The child session lives under the parent session's dir (same layout as foreground).
The parent session did not receive the completion notification in this capture because the RPC
driver stopped the parent first; background completion is therefore only readable from `status.json`.

### Where is the goal entry? (`goal.jsonl`)
`{type:"custom", customType:"goal-state", data:{goal:{id,text,status,startedAt,updatedAt,iteration,
tokensUsed,timeUsedSeconds,baselineTokens,activeStartedAt?,automaticModelTurns,toolFreeRepeatCount,
tokenBudget?,waiting?:{reason,resumeAt?}}|null}}`. Status in the run: `active` ... `complete`
(then a `{goal:null}` entry, see difference 2). `GoalStatus = active|paused|blocked|usage_limited|
budget_limited|complete` (matches `prompts.ts`). `waiting` only exists while `active` (source
`persistence.ts`; not observed). The first goal-state entry appears BEFORE the user message entry.
The same entry can be duplicated back to back (two identical `active` entries at start).
The finishing tool is `goal_complete` (args `{goal_id, summary}`; result `details.{goal,goal_id,summary}`).
Legacy customType `goals-state` exists in the extension; ignore.

### read/edit/write tool names and path key
`read`, `edit`, `write`, all with `arguments.path` (observed for `write`; `read.js`/`edit.js` in
pi 1.0.2 declare `path` too). `edit` also has `edits[]`. Paths may be relative (`a.txt`); the plan
path regex only matches paths that contain `docs/superpowers/plans/`.

### Do child sessions land in the hub's indexed dir?
They are inside `sessionsDir()` but **nested too deep to be indexed**:
`<sessionsDir>/<cwd-slug>/<parent file>/<runId>/run-0/session.jsonl`, whereas `SessionIndex.list()`
only reads `*.jsonl` directly in `<sessionsDir>/<slug>/`. Child headers carry no `parentSession`.
So children never appear in `GET /api/sessions` and the panel must open them by explicit path
(from `results[].sessionFile`). Related artifacts under `<slug>/subagent-artifacts/` are not
indexed either.

## Other observations
- `pi-permission-system` raises `extension_ui_request` `select` ("Permission Required") for the
  first use of each tool in RPC mode; the capture driver answered `Yes, allow tool ... for this session`.
- Side effect: subagent calls create mission files under `~/.pi/agent/missions/` and runtime state
  under `/tmp/pi-subagents-uid-<uid>/`.
- `subagent-fg.rpc-events.jsonl`: dropped `extension_ui_request` events, `role:"system"` messages
  (both as message_start/end events and inside `agent_end.messages[]`, which now holds only
  user/assistant/toolResult messages), and text/thinking deltas; `message_update` kept as
  `{type, assistantMessageEvent:{type}}` stubs; `thinking` text blanked. Every `tool_execution_*`
  event is intact apart from clipping strings over 3000 chars.
