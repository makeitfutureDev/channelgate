---
title: Automation delivery
description: Choose threaded results, daily threads, direct channel posts, or private matching alerts.
---

Schedule timing and result delivery are separate choices. A normal “every morning, summarize updates” request uses standard delivery unless you explicitly choose another mode.

## Delivery modes

| Mode | Result placement | When to use it |
| --- | --- | --- |
| `standard` | Running announcement with the answer in its thread | Default scheduled task |
| `daily-thread` | One running message per gateway-local day; runs threaded beneath it | Several recurring checks in one daily thread |
| `channel` | Result posted at top level without a result thread | A report intended for the channel feed |
| `dm-on-match` | Only a prefix-matching result DM'd to the creator, then checks stop | [Conditional monitoring](/docs/features/conditional-monitoring) |
| `thread` | Results in one existing thread in this conversation | Keep a monitor's reports together without new top-level anchors |

Daily-thread delivery is only for recurring tasks. It cannot be used for reminders, one-time tasks, or fixed `interval_days` schedules.

Fixed-thread delivery requires a valid existing thread ID in the same conversation and a platform with native threading. It does not share an ordinary schedule's engine session: each fire starts fresh. Synthetic engine session keys are not delivery threads.

## Quiet checks and useful results

Ask for `execution_visibility: "silent"` to skip running announcements. With `result_policy: "on-result"`, an explicitly reported healthy `no-op` also produces no result message. Useful results still arrive at the selected destination; a silent standard run without an anchor posts its result at top level. A silent daily-thread task creates its daily thread only when it has a result to deliver.

Engine completion and task completion are separate. Each task receives a structured reporting instruction: `succeeded` means expected work completed, `no-op` means all required checks succeeded with nothing to report, `blocked` means a prerequisite is missing, and `failed` means attempted work did not complete. A missing or invalid report is `unreported`. Connection claims are agent-reported evidence, not independent verification; an unavailable connection prevents success and an unknown connection prevents a healthy no-op.

Silence does not hide errors by default. `failure_notify: false` suppresses failure messages while preserving execution history. These options apply to agent tasks, not reminders. `notify: "none"` controls pings independently; it does not itself suppress messages. DM-on-match retains its separate rule of no routine or failure posts.

## Notification choices

`notify` defaults to `channel`. This means the channel is notified in the run's own thread; it does not change the result to a top-level post. `user` targets a named recipient, and `none` suppresses the ping. Ask for a personal recipient or silence explicitly. A user-mode schedule created through an HTTP API run must supply `notify_user`, because that principal is not a person to ping.

For example: “Every weekday at 9, publish the report at top level without a ping” selects `delivery: "channel"` and `notify: "none"`. “Keep today's checks together” selects `daily-thread`.

## Check delivery failures

**Automations** shows execution and delivery status. The scheduler saves completed task results before delivery so a delivery retry can send the saved result rather than rerun external actions. An interrupted running task can have unknown external effects; inspect before re-enabling it.

Ask the agent to inspect `get_schedule_runs` for this conversation's recent outcomes, connection evidence and bounded event trail, including completed one-time or deleted schedules. Completed history is retained for 90 days without backfill. Engine completion, task outcome and delivery status are separate facts; a failed delivery can coexist with completed work, and a suppressed message does not mean a run never happened.

Scheduled, background, API, and recovery posts have an unbound Slack reply menu: each person who opens it is checked under their own current conversation access. Ordinary reply controls are bound to the original requester, with the documented admin exception for files. An automation menu grants no extra authority.

The connected platform determines which mentions, threading, and controls render. Slack delivery options are the reference workflow; consult the Beta platform guides for current differences.

## Related guides

- [Restart and recovery](/docs/features/restart-and-recovery)
- [Schedules](/docs/features/schedules)
- [Automation controls](/docs/controls/automation)
