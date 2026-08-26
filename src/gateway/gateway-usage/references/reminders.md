# Reminders & scheduled tasks

Use the gateway tool **`create_schedule`** (always available) to run something later — once or on
a repeating schedule — in THIS channel. It runs as **you** (your tokens, your mode) in this
channel's folder, and posts back here. Creating and deleting schedules needs NO approval click —
just call the tool. Say what you scheduled (and when it will fire) in your reply so the channel
can see it, and use `list_schedules` / `delete_schedule` to show or undo it.

## One-time vs recurring
- **One-time:** pass `in_minutes` (run N minutes from now, e.g. `120` = in 2 hours) OR `run_at`
  (an ISO-8601 local datetime like `2026-06-26T15:30`). Leave `cron` empty. It runs once, then
  auto-deletes.
- **Recurring:** pass `cron` — a 5-field expression `minute hour day-of-month month day-of-week`
  in server local time. Examples: `0 9 * * *` = every day 09:00; `0 9 * * 1` = Mondays 09:00;
  `0 * * * *` = hourly. Recurring schedules must fire no more often than the configured minimum
  interval (default 60 min) or the call is rejected.

## Task vs reminder
- `kind:"task"` (default) — actually runs a Claude session with your `prompt` at that time (it
  does real work and reports the result). Costs tokens.
- `kind:"reminder"` — posts a **single reminder message** (the `prompt`/`description` text). No
  Claude session, no token cost. Use this for plain "remind the channel to X" nudges.

## Fields
- `prompt` — what to do (task) or the reminder text (reminder). Required.
- `description` — short title shown in the "Running:" announcement.
- `notify` — who gets pinged: `"channel"` (@channel, default), `"user"` (pass a Slack user id in
  `notify_user`), or `"none"` (quiet).
- Reminder acknowledgement (only when `kind:"reminder"`): `ack:true` requires someone to react
  ✅. If nobody does within `ack_escalate_minutes` (default 120) a second notice is posted; after
  `ack_dm_minutes` (default 60) more the creator is DM'd and the chain closes. Any ✅ closes it.

## Manage existing schedules
- `list_schedules` — list this channel's schedules (id, on/off, cron, description, who it
  notifies).
- `delete_schedule` — delete one by `id`.

There's a per-channel cap on enabled schedules (a runaway backstop); if you hit it, delete an old
one first.

**Not for repeating work in THIS thread.** A schedule always starts a fresh, context-less run and
announces itself in the channel. To iterate on something here, where each pass builds on the last,
use a loop instead — `references/loops.md`.

## Examples
- "Remind me in 2 hours to call the client" → `create_schedule` with `in_minutes:120`,
  `kind:"reminder"`, `prompt:"Call the client"`, `notify:"user"`, `notify_user:<their id>`.
- "Every weekday at 9am, summarize new messages" → `create_schedule` with `cron:"0 9 * * 1-5"`,
  `kind:"task"`, `prompt:"Summarize what's new in this channel since yesterday"`.
- "Post a standup reminder at 10:00 daily and make people ack it" → `create_schedule` with
  `cron:"0 10 * * *"`, `kind:"reminder"`, `ack:true`.

For a message that Slack itself sends at a set time (not a gateway-driven run), use the selected
personal/shared Composio Slack toolkit's “schedule message” action — see `references/messages.md`.
