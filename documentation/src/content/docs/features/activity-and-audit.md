---
title: Activity and audit
description: Inspect run history separately from configuration and security events.
---

The **Activity** page combines two histories: completed run and usage records, and **Admin & security events** describing operational and configuration changes.

## Find a run

The run history is newest first. Search conversation or author and filter by conversation, user, or engine. Open a record to inspect its reported usage and runtime details. Overview provides aggregate charts; Activity provides the underlying run-oriented view.

For example, if a scheduled result is missing, check its automation state, then find the associated run. A successful run with failed delivery needs a different remedy from an engine authentication failure.

## Inspect a change

The event feed records changes such as conversation policy, schedule/background lifecycle, and secret reveal actions. Conversation change events describe changed keys and safe summaries; secret values are excluded. Password-authenticated web actions are attributed to **admin UI**, because the web password does not establish an individual Slack identity.

Do not treat this as an immutable compliance ledger. It is operational history stored in the same gateway SQLite database and governed by that installation's backups and operator access.

## Scope and limits

Activity is an authenticated admin page. Its history reads are bounded: the run endpoint defaults to **500** records and caps at **2,000**; the events endpoint defaults to **200** and caps at **1,000**. Filters narrow the view; a bounded response may not contain the entire lifetime history.

Run usage and security events are separate evidence. A run record does not prove every external action succeeded, and an event actor should not be inferred beyond the identity the system recorded.

## Your personal Activity dashboard

The Dashboard button in a Slack reply and **Slack Home → Activity → Open live dashboard** open
your own agent threads, separately from the administrator's history page.

The private launch link can be opened repeatedly for ten minutes after creation. Reopening never
extends that deadline. Each successful open starts a browser session that can keep loading and
refreshing for up to twelve hours. The dashboard page can be reloaded during that session even
after its launch link expires. Reading data and reconnecting do not extend the session deadline;
current user, workspace, and conversation access checks still apply.

If a launch link expires, click Dashboard again or reopen Activity in Slack Home for a new one.
Keep these private links to yourself. New private messages describe both the ten-minute launch
window and the twelve-hour dashboard session; previously sent ephemeral messages retain their
old text. A gateway restart ends existing launch links and browser sessions.

## Related guides

- [Usage and costs](/docs/features/usage-and-costs)
- [Live sessions](/docs/features/live-sessions)
- [Failure diagnosis](/docs/features/failure-diagnosis)
