---
title: Automation controls
description: Create, update, inspect, and delete conversation schedules and their execution history.
---

Scheduling is available to authorized conversation participants. These tools are inspectable and reversible, and do not add a separate persistent-control approval click. Execution still checks the creator, conversation access, runtime, and license. Schedules are bound to this conversation.

## create_schedule

**Required:** `prompt` (string). Also provide a valid timing choice below. **Authority:** authorized participant. The schedule executes as its creator; an HTTP API principal has no implicit personal identity.

| Argument | Required or optional | Accepted value/default |
| --- | --- | --- |
| `cron` | Timing choice | Five fields, gateway-local timezone |
| `interval_days` | Alternative timing | Integer 1–365; tasks only |
| `in_minutes` | Alternative timing | Positive delay for one-time execution |
| `run_at` | Alternative timing | Parseable ISO datetime; one-time execution |
| `description` | Optional | Announcement/title; otherwise prompt |
| `notify` | Optional | `channel` (default), `user`, `none` |
| `notify_user` | Optional | User ID; defaults to creator for user notification outside HTTP API runs |
| `delivery` | Optional | `standard` (default), `daily-thread`, `channel`, `dm-on-match`, `thread` |
| `delivery_thread` | Conditional | Existing thread ID in this conversation for `thread`; defaults to the current thread when available |
| `execution_visibility` | Optional | `visible` (default) or `silent`; silent is for agent tasks only |
| `result_policy` | Optional | `always` (default) or `on-result`; on-result is for agent tasks only |
| `failure_notify` | Optional | True by default; false suppresses failure messages for agent tasks |
| `match_prefix` | Conditional | Required nonempty for `dm-on-match` |
| `kind` | Optional | `task` (default), `reminder` |
| `ack` | Optional | False by default; applies only to reminders |
| `ack_escalate_minutes` | Optional | Reminder escalation delay; default 120 |
| `ack_dm_minutes` | Optional | Delay after escalation before creator DM; default 60 |

Use **one timing form**. `interval_days` cannot combine with cron, one-time timing, reminder kind, or daily-thread delivery. When both one-time fields are present, a positive `in_minutes` is used first; provide only the intended field. Invalid/past dates are refused.

Recurring cron must meet the configured minimum interval (**60 minutes by default**). The conversation has a default ceiling of **20 enabled schedules**. Daily-thread requires recurring tasks. DM-on-match requires a task, creator, and prefix; routine results and errors remain in status, while the first matching answer is privately delivered and disables the schedule.

A reminder posts its saved text without starting an engine. With acknowledgment enabled, a ✅ closes the escalation chain. A task runs an engine with the current resolved creator/conversation settings.

`silent` suppresses the running announcement, not task execution or useful results. `on-result` suppresses only an explicitly reported healthy `no-op`; failed checks or missing reports are not no-ops. Failure messages remain enabled unless explicitly disabled. Thread delivery requires a valid existing thread ID in this conversation and native platform threading; synthetic engine session keys are refused. A fixed delivery thread does not reuse an ordinary schedule's engine session: each fire still starts fresh. Silent execution, result-only filtering, disabled failure notifications and thread delivery are refused for reminders.

The result returns an ID and next time/notification choice. It is confirmation of creation, not proof of task completion. Quote the gateway's named timezone rather than relabeling it as container UTC.

Example recurring task:

```json
{"cron":"0 9 * * 1-5","prompt":"Summarize the release status using the linked sources","description":"Weekday release status"}
```

Example direct reminder:

```json
{"in_minutes":120,"prompt":"Check the deployment","kind":"reminder","ack":true}
```

## list_schedules

**Arguments:** none. **Authority:** authorized participant.

Lists this conversation's schedules, IDs, enabled state, timing, descriptions, notification, and applicable delivery notes. It does not expose another conversation or constitute a full execution log. The authenticated **Automations** page provides richer operational status.

Example arguments:

```json
{}
```

## get_schedule_runs

**Arguments:** all optional. **Authority:** authorized participant; results are scoped to this conversation.

| Argument | Accepted value/default |
| --- | --- |
| `schedule_id` | Filter history to one schedule, including a deleted or completed one-time schedule |
| `run_id` | Fetch one run in this conversation; takes precedence over list filters |
| `limit` | Integer 1–100; default 50 |
| `before` | Run ID cursor; return runs older than this run |

Returns JSON with `summary` and newest-first `runs`, or a single run for `run_id`. For older pages, use the last returned run's ID as `before`. A missing or foreign `run_id` returns an error; an unknown cursor returns an empty list.

History retains completed runs for 90 days, without historical backfill. It includes scheduling delay, execution and delivery status, engine/model, duration, recorded tokens/cost, a bounded summary and connection outcomes. `engineStatus` describes engine completion; `taskStatus` and `outcomeSource` distinguish agent-reported results from gateway facts. A completed engine is not proof that the external task succeeded. Missing or invalid task reports remain `unreported`.

The bounded event trail records lifecycle events, tool names and completion/failure statuses, with a dropped-event count when truncated. It does not retain tool arguments, raw outputs, reasoning or credential payloads. Deleting a schedule preserves its run history within retention.

```json
{"schedule_id":"schedule-id","limit":20}
```

## update_schedule

**Required:** `id` (string). **Authority:** authorized participant; only schedules in this conversation can change.

| Optional argument | Accepted value |
| --- | --- |
| `execution_visibility` | `visible` or `silent` |
| `result_policy` | `always` or `on-result` |
| `failure_notify` | Boolean |
| `delivery` | `standard`, `daily-thread`, `channel`, `dm-on-match`, `thread` |
| `delivery_thread` | Existing thread ID in this conversation; current thread is used for `thread` if available and omitted |

Changes only the supplied options. The same task/reminder and thread validation as creation applies. Daily-thread requires a recurring task; switching to DM-on-match requires the schedule's existing creator and match prefix. Timing, prompt, enabled state, recipient and match prefix are not arguments to this control; use the admin Automations editor for those changes. A delivery change keeps execution fresh per fire and does not replay earlier actions.

```json
{"id":"schedule-id","execution_visibility":"silent","result_policy":"on-result","failure_notify":true}
```

## delete_schedule

**Required:** `id` (string). **Optional:** none. **Authority:** authorized participant.

Deletes only a schedule belonging to this conversation. A missing or foreign ID returns not found. Deleting a schedule is not a rollback of external actions a prior run already performed.

Example arguments:

```json
{"id":"schedule-id"}
```

## Related guides

- [Schedules](/docs/features/schedules)
- [Automation delivery](/docs/features/automation-delivery)
- [Conditional monitoring](/docs/features/conditional-monitoring)
- [Reminders and acknowledgments](/docs/features/reminders-and-acknowledgments)
