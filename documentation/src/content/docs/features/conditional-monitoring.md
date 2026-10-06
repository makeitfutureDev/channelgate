---
title: Conditional monitoring
description: Check on a schedule and notify the creator only when a result matches a chosen prefix.
---

Conditional monitoring runs an agent task periodically while keeping routine results out of chat. When the answer begins with a chosen prefix, ChannelGate sends that result to the creator by DM and disables further checks.

## Set up a monitor

Ask: “Check this public status page hourly. Only DM me when service is restored, then stop checking.” Specify what counts as a match and have the task return a fixed prefix such as `RESTORED:` only on that condition.

The schedule uses `delivery: "dm-on-match"` and a nonempty `match_prefix`. The scheduler trims leading whitespace before testing whether the response starts with that prefix. It does not evaluate a structured condition independently of the agent's answer.

## Review the state

Find the monitor in **Automations** or ask the agent to list this conversation's schedules. A matching result is recorded as found, delivered privately, and the schedule is disabled. Routine checks produce no running announcements or result posts. Failures also stay out of routine chat delivery and remain visible in schedule status.

The task runs as its creator with the conversation's resolved tools, connectors, network policy, and licensing admission. Private notification does not grant a broader account or new authority.

## Limits

This mode requires an agent task, a creator, and a match prefix. It is not available for direct reminder messages. The standard recurring interval floor applies: **60 minutes by default**, with at most **20 enabled schedules per conversation**. Fixed intervals of **1–365 days** are also available for tasks; they cannot combine with cron or daily-thread delivery.

Because each check consumes an agent turn, use explicit evidence and a narrow condition. “No message” does not prove a check succeeded; inspect status when reliability matters.

## Related guides

- [Automation delivery](/docs/features/automation-delivery)
- [Schedules](/docs/features/schedules)
- [Automation controls](/docs/controls/automation)
