---
title: Thread loops
description: Repeat a Claude task in the same thread with durable wakeups, visible pacing, and a finite tick budget.
---

A thread loop repeats work while keeping the same thread's session and accumulated context. Use it for a short period of active monitoring or iterative work, rather than creating an unrelated fresh scheduled task each time.

ChannelGate bridges Claude Code's native loop pacing into durable gateway schedules. This is a Claude harness capability; it is not a universal Codex command. A general scheduled task can run either supported engine when you need engine-independent recurring work.

## Start an explicit loop

Choose Claude for the thread, then send a loop request as message text in Slack:

```text
@ChannelGate /loop 5m check whether the build has completed.
Report changes in this thread and stop once it succeeds or fails.
```

Use the configured bot name. The assistant performs the task and requests the next wakeup. ChannelGate posts the actual pacing and remaining budget in the same thread. Verify that notice rather than assuming the loop exists because the assistant described an intention to repeat.

A fixed-interval loop preserves its cadence; dynamically paced loops rearm after each iteration. A dynamic loop that fails to request another wakeup stops instead of inventing the next run.

## Inspect and stop

The pending wakeup appears under **Automations** and the conversation's **Settings → Automations**, alongside schedules and reminders. It targets the original thread, resumes that thread's session, and does not mention the channel on every tick.

To end it, send a stop word in that thread with the required mention, or use a supported stop reaction. Clearing the thread also cancels its pending loop. Between ticks there may be no running agent process, so cancel the saved wakeup rather than just looking for a busy task.

## Limits and costs

Each loop has a default budget of **24 future ticks**. The remaining count survives rearming and is decremented as ticks fire. The thread receives an explicit notice when that budget is exhausted.

Fixed-interval loops have a **one-minute minimum**, separate from the ordinary recurring-schedule default of 60 minutes. They share the conversation's enabled-schedule ceiling, which defaults to 20 records.

Every tick is an engine run under the current conversation's permissions and relevant author authority. It consumes provider tokens and applicable license messages. Neither the loop nor its saved schedule grants extra network, connector, or host access.

## Related guides

- [Claude Code](/docs/features/claude-code)
- [Schedules](/docs/features/schedules)
- [Threads and sessions](/docs/features/threads-and-sessions)
- [Usage and costs](/docs/features/usage-and-costs)
