---
title: User administration
description: Approve people, assign administrator roles, manage preferences, and inspect masked account configuration.
---

The **Users** page manages people known to the gateway. Approval allows a person to pass user admission, while administrator status grants gateway control authority. Conversation access policies still determine where ordinary users may participate.

## Find and edit a person

Search by name, user ID, visible role, reminder preference, or configured connector status. The search operates on the masked representation, not secret values. Open the person's drawer to edit approval, administrator status, quiet-thread reminders, and supported personal configuration.

A person being approved does not give them the admin web password. Conversely, web actions use a shared password-authenticated admin session rather than a named chat author.

## Personal configuration

Users can have personal Composio and Toolbox tokens, environment variables, and personal grants. Listings show credential presence and masked suffixes. Blank credential fields retain the current value; removal uses the explicit clear action.

When investigating a connector issue, confirm both the intended identity and the connected service account. An account marker does not prove that a particular provider connection is active.

## Reminders and defaults

New users capture the organization quiet-thread reminder default, which is off unless an administrator enables it. Individuals can change their preference in Slack App Home. Applying the default to all existing users deliberately replaces their stored preferences.

## Practical workflow

For a new team member, verify their identity, approve access, grant the appropriate conversation access, and keep the administrator role off unless they need gateway administration. Then have them send a bounded test in the intended conversation.

Do not approve an integration bot as though trust alone were sufficient; [trusted bot triggers](/docs/features/trusted-bot-triggers) also need an allowed integration identity and a real bot mention.

## Related guides

- [Access and users](/docs/configuration/access-and-users)
- [Quiet-thread nudges](/docs/features/quiet-thread-nudges)
- [Connected accounts](/docs/features/connected-accounts)
