---
title: Gateway settings
description: Set organization defaults and understand which changes apply to existing conversations.
---

Gateway settings define the deployment's chat connections, available engines, default behavior, shared integrations, and security policy. They are separate from a conversation's own settings and from a person's connected accounts.

## Where to configure

Sign in to the admin web interface and open **Settings**. Use **Search settings…** or the section navigation. One **Save** at the bottom saves the page's changed settings. Values are stored in `~/.channelgate/config/settings.json`, under the daemon account's home; a custom runtime root changes this location. Saved values take precedence over matching bootstrap environment variables.

| Section | What it controls |
| --- | --- |
| Connection | Slack, Microsoft Teams, Google Chat, public URL, approval links |
| Agent defaults | Enabled harnesses, engine/model defaults, failover, instructions, memory, scheduling limits |
| Access Templates | Starting conversation settings and reusable skill assignments |
| Integrations | Shared environment variables, Composio mode and endpoints, organization token defaults |
| License | License key, verification state, conversation message allowance |
| Access & security | Organization grants, default conversation access, model-change policy, container runtime |
| System | Admin authentication, run API token, reconnect and restart controls |

## Choose a starting policy

1. Configure at least one chat platform and one working engine login.
2. Set the default engine and model under **Agent defaults → Engine & runtime**.
3. Review **Access & security → Default channel access** before adding the bot to new conversations.
4. Review the channel and DM templates under **Access Templates**. A new channel's template can include Worker, Auto, and network access; a user's DM has its own template.
5. Save and send a small test request from an approved account.

An example organization instruction is:

```text
When changing a project, read its instructions first.
Explain the result and name any verification you performed.
Ask which connected account to use when a write's identity is unresolved.
```

## How changes apply

Most settings apply to subsequent messages without restarting the daemon. Changing Slack credentials through **Save** also attempts a live reconnect. Other platform controls provide their own connect/reconnect actions. Container creation settings can recreate affected containers at their next turn; the conversation's persistent HOME volume is retained.

Some defaults are deliberately copied once: **Default channel access** affects newly registered channels, and the channel template initializes new channels. Organization skill and connector grants are a live union and affect existing conversations too. DM templates remain live selections.

If another administrator saves after you loaded the page, a conflicting save is refused. Reapply your intended changes to the latest values instead of restoring an old whole-page snapshot.

## Permissions and related guides

The admin web interface manages deployment settings. Becoming a channel manager does not grant admin access or permission to change organization settings. Use [Channel settings](/docs/configuration/channel-settings), [Access and users](/docs/configuration/access-and-users), and [Admin dashboard](/docs/features/admin-dashboard) for those scopes.
