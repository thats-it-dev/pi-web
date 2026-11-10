# @pi-web/bg

pi extension for long commands (CI waits, ship). pi no longer blocks on them.

- `bg_bash { command, cwd? }` starts the command detached under `bash -lc`, logs to `$TMPDIR/pi-bg/<pid>/<id>.log` and returns a job id (`bg-1`, `bg-2`, ...) at once. The footer shows `N background jobs` (status key `bg-jobs`).
- `bg_status { id? }` lists jobs with state, run time and the last lines of output.
- `bg_cancel { id }` sends SIGTERM to the job's whole process group.

When a job exits, the extension sends a `bg-bash-done` message (displayed, queued as a follow-up, starts a turn). Its text:

```
bg_bash job bg-1 exited 0 after 3m 12s: <command, up to 120 chars>
RESULT {...}            (the last RESULT line of the log, if not already in the tail)
<last 60 lines of output>
```

A cancelled job says `was cancelled` instead of `exited <code>`. On `session_shutdown` running jobs are killed and nothing is sent.
