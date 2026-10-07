---
title: Quiet-thread nudges
description: Opt in to one gentle reminder when an agent thread goes unanswered.
---

A quiet-thread nudge mentions the person who requested the agent's last reply when that thread remains unanswered. It posts once in the same thread and asks whether the person wants to continue.

## Choose your preference

Users can change their quiet-thread reminder preference in the Slack app's **Home** tab. Administrators can change an individual's preference in **Users**.

The organization default is **off**. **Settings → Agent defaults → Schedules & nudges** contains:

- **No-response reminder (hours):** default **24**.
- **New users start with quiet-thread reminders ON:** captures the preference for newly seen users.
- An action to apply the organization default to existing users, replacing their individual values.

Changing the new-user default does not silently reset every existing preference.

## What happens

For example, an agent proposes two deployment options and you leave the thread unanswered. If reminders are enabled for you, the daemon's periodic sweep can post a personal mention after the configured silence threshold. Any subsequent user activity clears the tracked waiting state.

The sweep runs every **30 minutes**, so a reminder need not arrive at the exact threshold second. A nudge does not start a new engine run or continue the task automatically.

## Limits

Nudges are best effort: their per-thread tracking lives in memory and is lost on restart. Entries expire after **seven days**. Posting failure is marked attempted to avoid repeated spam. This differs from durable [follow-up digests](/docs/features/followup-digests).

The current sweep is connected to Slack. Turning on a user's preference does not establish equivalent Beta platform behavior.

## Related guides

- [User administration](/docs/features/user-administration)
- [Reminders and acknowledgments](/docs/features/reminders-and-acknowledgments)
- [Notification configuration](/docs/configuration/notifications-and-automation)
