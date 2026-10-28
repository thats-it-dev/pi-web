# Push alerts with an agent-written TL;DR — design

Status: draft for Michael's review (2026-10-28).

## 1. Intent

Michael wears a Pebble Time 2 and uses pi-web as a PWA on his phone. Today a
closed watch app gets alerts through a Developer Connection BlobDB
notification, which only works while the Pebble phone app is in the foreground.
Web Push is the fallback, and its body is the reply clipped to 160 characters.
In practice the watch notices are poor (Michael's words).

The fix: **Web Push becomes the only alert path**. The phone mirrors every push
to the watch, so it reaches the wrist reliably. Each push carries a **one-line
TL;DR that the agent itself wrote**, so a glance at the wrist says what
happened. Michael answers pending questions with a ring note; the existing
closed-app ring path already does that. The notification needs no buttons.

## 2. Goals, non-goals, anti-goals

Goals:
- One alert path, Web Push, for every event in §4.
- A finished turn's push says the outcome in one line, written by the
  session's own model.
- No push for a session Michael is already looking at in the PWA.

Non-goals:
- Changing the watch app (Michael: "leave it for now; we might revisit it
  later"). It keeps working as is, minus the BlobDB launch path.
- Notification action buttons. Answers come by ring note.
- Summaries written by a second model call.

Anti-goals (would make it a failure even if it works):
- A push with an empty body, or one that says nothing ("Done.").
- A TL;DR that suggests next steps or asks things. Michael chose **outcome
  only**.
- Michael reading the same sentence twice in the chat: the TL;DR line must not
  clutter the reply in the PWA.

## 3. Decided by Michael

- The trigger is that watch notices are poor. Push replaces them.
- He answers from the wrist by ring note. The push itself is read-only.
- The watch app stays as it is for now.
- Pushes go out for: every finished turn; approvals and pi questions;
  ring-profile questions; errors and stuck sessions.
- A finished turn's TL;DR states the **outcome only**.
- **The pi agent itself writes the TL;DR**, not the hub on another model.
- **Remove** the Developer Connection notification path entirely, including the
  BlobDB frame code and the alert-mode setting.
- A push is held back only when **the PWA is visible on that same session**.

## 4. Events and what each push says

The title stays as today (`sessionTitle`).

| Event | Body |
|---|---|
| Turn finished | The agent's TL;DR. If it is missing, the reply's first text clipped as today. |
| Approval / pi select or confirm dialog | The dialog's question, as `dialogMessage` gives it today, clipped. |
| Ring-profile question | The query text as ring-profile sent it. It is already one screen long and linted (ring-profile spec §9). |
| Turn ended in error | The error text, clipped. |
| Stuck: a dialog or question still waiting after N minutes | "Still waiting:" plus the same body as the original push. Sent once per dialog or query. |

Ring alerts that exist today ("Didn't catch that", and the answered receipt for
the closed-app ring path) also go out as pushes.

## 5. The TL;DR

- Every session pi-web runs (headless) gets a system-prompt rule. When the
  agent ends its turn with a final reply, it ends that reply with one line in a
  fixed, machine-findable form, for example `TL;DR: <outcome>`.
- The line states what was done or found, in at most about 100 characters.
  It contains no question and no suggestion.
- The hub reads the line when the turn ends and uses it as the push body.
- The PWA does not show the raw line inside the reply. It hides the line, or
  renders it as a small distinct summary. Either way Michael never reads the
  same text twice.
- If the line is missing, the push falls back to today's clipped text (Claude's
  call), so a push is never empty.

## 6. Delivery

- Web Push (the existing `hub/src/push.ts` subscriptions and the service
  worker) is the only path. The phone mirrors it to the watch.
- **Suppression:** the PWA reports which session it is showing while it is
  visible. The hub holds back a push for session S only while a visible PWA
  client is on S. Today any visible PWA (the `Viewers` count) silences
  everything; that is replaced.
- Every other alert pushes. Whether the watch app is open no longer affects
  pushes (Claude's call: the watch app shows its own state when open, and a
  mirrored push on top is the cost of one simple rule. Revisit if it's
  noisy).
- **Removal:** delete the Developer Connection notification path. That means
  `notification-frame.ts`, the BlobDB send, the launch-code table that serves
  it, and the `auto | notification | push | off` alert-mode setting. A
  single on/off for pushes may stay (Claude's call). Remove the watch-side
  code and docs that only served the launch-from-notification path; leave
  everything else in the watch app alone.

## 7. Constraints

- Local-first: nothing new leaves the tailnet except what Web Push already
  sends. Push bodies are short and reach the push service as today.
- The watch API's auth stays tailnet identity only (a decided matter; don't
  revisit it).
- No extra model call per turn, and no new dependency on a loaded local model.
- Terminal (bridge) sessions: keep today's rule that only headless sessions
  push (Claude's call: someone at a terminal is at the terminal).

## 8. Settled details (Claude's calls)

- **Every headless spawn carries the TL;DR rule**, resumes (`--session`)
  included. The rule is injected per spawn (an extension or flag), never
  persisted into session content. Sessions that are already running keep the
  fallback until they are respawned.
- **The marker is the last line of the turn's final assistant message.** A
  message followed by tool calls doesn't count. If there are several, the last
  match wins. Lines inside code fences are ignored. The hub strips the line
  before building the clipped fallback for any other use. The PWA's hide or
  render applies to history reloaded from the session JSONL as well as to live
  replies.
- **Suppression is per session.** A visible PWA on the session list, or on a
  different session, does not hold back a push for S (this follows from
  Michael's choice). Any one visible client on S suppresses it, on any device.
  A client's report lasts only as long as its connection: on disconnect or
  hidden, the client counts as not viewing.
- **The watch keeps its current behaviour.** The watch hub's existing
  any-app-visible check (`viewers.watching()` in watch.ts, used to show and
  clear outcomes) keeps its old meaning, with a global count kept alongside the
  new per-session tracking. With BlobDB gone, the Notifier's `appOpen` and
  `phone` gating are no longer used for alerts.
- **Ring-profile questions** are the queries ring-profile already raises
  through the hub's internal query API (`QueryStore`). The push path routes
  those, and depends on no code that ring-profile hasn't built yet.
- **Stuck** means a pi dialog or a ring-profile query still unanswered N minutes
  after it appeared.
  - The hub owns the timer. Any answer, skip, clear or expiry, on any surface,
    cancels it.
  - It is sent at most once per dialog or query.
  - A hub restart drops pending timers; no stuck push is sent for those.
  - The stuck push is suppressed by the same per-session rule.
  - A running turn that makes no progress is out of scope. Michael's option
    read "a session that's been waiting a long time".
- **Settings:** one hub-wide `push: boolean` (default true) replaces the alert
  mode. A stored alert mode of `off` migrates to `false`; anything else
  migrates to `true`.

## 9. Left to the builder

- The exact TL;DR marker and how the rule is injected. Options include a pi-web
  extension hook, an appended system prompt, or a tiny `tldr` tool. Use
  whatever pi supports cleanly. It must work for every model pi-web runs.
- How the PWA hides or renders the TL;DR line.
- The stuck threshold N. Start at 15 minutes (Claude's call).
- How the PWA reports the session it is viewing, for example over the existing
  events stream or a small heartbeat.
- The order in which the BlobDB path is removed and the code is tested.
