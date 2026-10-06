---
title: Access and users
description: Approve users and separate conversation use, conversation management, and organization administration.
---

ChannelGate checks who may talk to the bot before starting an agent run. Permission to use a conversation, permission to manage it, and organization administrator status are separate decisions.

## Approve a user

Open **Users** in the admin interface. Select an existing user, or use the add-user control with the platform identifier, and set their approval status. The user drawer also contains administrator status, personal connections, skill grants, and reminder preferences. A person's display name alone is not a reliable identifier.

An approved user can use their own DM with the bot. A channel's policy can still restrict the same user in that channel. The bot's presence in a chat does not approve everyone who can see it.

## Conversation access policies

Use **Conversations → [conversation] → Access**, or Slack's conversation settings.

| Policy | Who can start runs |
| --- | --- |
| Approved members | Organization-approved users and admins participating in the conversation |
| Admins only | Gateway admins |
| No one / named users | Only people explicitly added to Allowed users |
| Allowed users | An explicit conversation grant permits that person even when the base policy excludes them |

The default for newly registered channels is **Approved members** unless the administrator changes **Settings → Access & security → Default channel access**. Changing this default does not rewrite existing channels. **No one** also blocks admins from ordinary use until they have an explicit grant.

Explicit conversation grants do not give guests access to their own DM or to other channels. They also do not create a reduced tool profile for that guest: each admitted person uses the conversation's effective settings, with admin-only privileges still checked against their own identity.

## Delegate conversation management

The conversation management policy offers **admins**, **members**, or a **custom** list of managers. Its default is admins. The members option allows approved members to manage the settings covered by that policy; a custom list names specific managers. Gateway admins retain management access.

1. Choose the narrowest conversation use policy that fits the team.
2. Add explicit guests only to the conversations they need.
3. Choose who manages that conversation's Access settings.
4. Review **Who can change the model/runtime in channels** separately. Its default is **Org admins only**.
5. Verify with an approved member and, where appropriate, a guest account.

## Effects and boundaries

User and access changes are checked on subsequent admissions; no daemon restart is needed. Changing a user's role does not change the container mounts by itself. Admin mode, host-home access, and an explicit `/sudo` thread are separate controls.

A trusted automation app also needs the required author approval and a real bot mention outside DMs; adding its ID under **Trusted bot apps** does not bypass authorization.

See [Permissions](/docs/features/permissions), [Approvals](/docs/features/approvals), [Sudo threads](/docs/features/sudo-threads), and [Model defaults](/docs/configuration/model-defaults).
