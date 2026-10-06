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

Daily-thread delivery is only for recurring tasks. It cannot be used for reminders, one-time tasks, or fixed `interval_days` schedules.

## Notification choices

`notify` defaults to `channel`. This means the channel is notified in the run's own thread; it does not change the result to a top-level post. `user` targets a named recipient, and `none` suppresses the ping. Ask for a personal recipient or silence explicitly. A user-mode schedule created through an HTTP API run must supply `notify_user`, because that principal is not a person to ping.

For example: “Every weekday at 9, publish the report at top level without a ping” selects `delivery: "channel"` and `notify: "none"`. “Keep today's checks together” selects `daily-thread`.

## Check delivery failures

**Automations** shows execution and delivery status. The scheduler saves completed task results before delivery so a delivery retry can send the saved result rather than rerun external actions. An interrupted running task can have unknown external effects; inspect before re-enabling it.

Scheduled, background, API, and recovery posts have an unbound Slack reply menu: each person who opens it is checked under their own current conversation access. Ordinary reply controls are bound to the original requester, with the documented admin exception for files. An automation menu grants no extra authority.

The connected platform determines which mentions, threading, and controls render. Slack delivery options are the reference workflow; consult the Beta platform guides for current differences.

## Related guides

- [Restart and recovery](/docs/features/restart-and-recovery)
- [Schedules](/docs/features/schedules)
- [Automation controls](/docs/controls/automation)
