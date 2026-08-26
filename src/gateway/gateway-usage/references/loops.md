# Loops — repeating a task in THIS thread

A **loop** repeats one task in the thread you are already in, keeping the thread's context between
iterations. Use it for "keep checking X until Y", "watch the deploy", "poll this every 5 minutes",
or any task whose next step depends on what the previous iteration found.

You do not need a gateway-specific tool for this. The harness's own `/loop` skill works here: the
daemon watches your pacing calls (`ScheduleWakeup` for a self-paced loop, `CronCreate` for a fixed
interval) and re-arms the thread itself. Schedule the wake-up exactly as you normally would.

## What the gateway changes, and why

`{{PLATFORM}}` turns are not an interactive session. Each turn is a separate headless process that
exits once your reply is posted, so the harness's own wake-up timer and its in-memory cron store —
which its documentation describes as "session-only … gone when Claude exits" — can never fire here.
The daemon therefore **adopts** the pacing decision you just made and stores it durably, then wakes
the thread at that time and resumes this same session, so the next iteration still has everything
this one learned.

Consequences worth knowing:

- **The tick is announced.** After your reply the thread shows when the next iteration will run.
  You do not have to restate it.
- **Tick granularity is one minute.** A delay is honored to the minute, not the second.
- **`CronList` is not bridged.** It reads the harness's own empty in-memory store, so it will
  always look empty. Use `list_schedules` to see what is actually armed — a loop appears there as a
  schedule bound to this thread.
- **Every loop is finite.** A loop stops after its tick budget (24 iterations) even if you never
  stop it, and the thread says so when that happens. Do not design a loop that assumes it can run
  unbounded.
- **Each tick costs a full turn.** Pick the longest delay that still catches what you are watching.
  A CI run that takes ~8 minutes deserves one ~8-minute check, not eight 1-minute ones.
- **This is Claude Code's mechanism.** If you are not running on Claude Code, the pacing tools above
  do not exist for you: say so plainly and offer `create_schedule` instead of pretending to loop.

## Stopping

- **You** stop it by calling the stop form of the wake-up (`stop: true`) on the iteration where the
  work is done. Say plainly in that reply that the loop is finished.
- **The user** stops it by saying `stop` in the thread. That cancels the run AND the pending tick.
- A tick that is superseded is replaced, never stacked: scheduling twice in one turn leaves one
  pending tick, not two.

## Loop vs schedule vs background job

| The work…                                                 | Use |
| --------------------------------------------------------- | --- |
| repeats in THIS thread and each pass builds on the last    | a loop (`/loop`, pacing tools above) |
| repeats in the CHANNEL on a calendar, independent each time| `create_schedule` — see `references/reminders.md` |
| is one long command that must outlive this turn            | `run_in_background` — see `references/background-jobs.md` |

Do not build a loop out of `create_schedule` calls that re-schedule themselves: those runs start
without the thread's context and announce themselves in the channel each time.
