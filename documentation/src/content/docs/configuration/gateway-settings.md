---
title: Gateway settings
description: Set organization defaults and understand which changes apply to existing conversations.
---

Gateway settings define the deployment's chat connections, available harnesses and their licenses, default behavior, shared integrations, and security policy. They are separate from a conversation's own settings and from a person's connected accounts.

## Where to configure

Sign in to the admin web interface and open **Settings**. Use **Search settings…** or the section navigation. One **Save** at the bottom saves the page's changed settings. Values are stored in `~/.channelgate/config/settings.json`, under the daemon account's home; a custom runtime root changes this location. Saved values take precedence over matching bootstrap environment variables.

| Section | What it controls |
| --- | --- |
| Chat connections | Slack, Microsoft Teams and Google Chat setup and connection controls |
| Messages / Calls | Replies, reactions, voice notes and approvals in Messages. Browser and iPhone calls in Calls |
| Integrations / Appearance | Composio, email, Drive sync, public file links and gateway branding |
| Agent defaults / Engine licenses | Default harness, model, effort, instructions and concurrency. Provider credentials and sign-ins under Engine licenses |
| Schedules & reminders | Schedule limits and quiet-thread reminders |
| Access & security / Admin access | New-channel access, trusted apps and administrator sign-in |
| License & usage | Product license, monthly usage and model rates |
| Gateway & runtime | Public URL, proxy and containers, resets and restart |

Open **Variables** for global environment variables, **Conversations → Templates** for channel and DM defaults, and **Skills** for organization grants and skill templates. **System health** shows Slack and harness status. **API** lists channel tokens and any existing deprecated organization-wide token.

## Choose a starting policy

1. Configure at least one chat platform and one working engine login.
2. Set the default harness and model under **Agent defaults → Engine & runtime**. When the harness has more than one usable license, also choose the default **License**.
3. Review **Access & security → Default channel access** before adding the bot to new conversations.
4. Review the channel and DM templates under **Conversations → Templates**. A new channel's template can include Worker, Auto, and network access; a user's DM has its own template.
5. Save and send a small test request from an approved account.

Two settings use the word license. The **License & usage** section holds the ChannelGate product license key, which sets the installation's tier and limits; see [license keys and limits](/docs/features/licensing). An engine license is a provider credential for Claude Code or Codex. Administrators add, verify, switch off, and remove engine licenses with the engine settings; see [engine licenses](/docs/features/engine-licenses).

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
