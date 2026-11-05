---
title: Admin dashboard
description: Manage conversations, users, automation, skills, integrations, and operating settings in one web interface.
---

The admin website runs as part of your ChannelGate installation. It manages the gateway and its conversations; it is separate from the public `channelgate.dev` documentation website.

## Sign in

By default, the daemon serves the interface on `http://localhost:4747`. An operator can change the port or put a trusted tunnel/reverse proxy in front of it. On first boot without a configured password, ChannelGate generates an admin password once and stores its hash. Use the password supplied by the installation's operator for initial setup, then verify and link your existing gateway administrator user. Normal sign-in uses a passkey, with optional password and Slack code sign-in as described below.

A public deployment should set **Settings → Connection → Public URL** to its reachable HTTPS origin. This also gives approval links a reachable address. Setting Public URL does not create a tunnel or open a firewall.

## Optional password and Slack code sign-in

A linked Slack administrator can enable **Settings → Admin access → Password and Slack code** after a fresh sign-in. It is off by default. Keep the current shared admin password or set a new one of at least 12 characters. During initial setup, verify and link the administrator first, then use this option to complete setup without creating a passkey.

On the sign-in page, choose **Sign in with password and Slack code**, enter the shared admin password and your Slack user ID, then enter the eight-digit code delivered privately by the gateway bot. Codes expire after five minutes, work only in the requesting browser, and allow at most five incorrect guesses. This option requires a current gateway Slack administrator and working private Slack delivery; approved members alone cannot use it. Passkeys remain available.

Changing the shared password or disabling this option revokes existing password-and-code sessions. Removing the user's administrator role also revokes access. Disabling it while signed in this way signs out that browser; retain another usable sign-in method before disabling it.

## Choose the right page

- **[Overview](/docs/features/usage-and-costs):** run, token, cost, model, user, conversation, and skill summaries.
- **[Conversations](/docs/features/conversation-administration):** work folders, engine settings, access, network, secrets, and grants.
- **[Users](/docs/features/user-administration):** approvals, admin roles, and user-specific configuration.
- **[Automations](/docs/features/schedules):** recurring tasks and reminders.
- **[Activity](/docs/features/activity-and-audit):** run records and diagnostic events.
- **[Skills](/docs/features/skills):** catalog content, revisions, sources, templates, and assignment.
- **[API](/docs/features/run-api):** examples and status for HTTP-triggered runs.
- **[Settings](/docs/features/settings-search-and-conflicts):** gateway-wide connections, agent defaults, container runtime, license, and system controls.
- **[System health](/docs/features/system-health):** host resource and storage history.

For example, to investigate a failing automation, inspect its schedule in Automations, its conversation settings, and its run in Activity. Change the narrowest applicable setting rather than copying gateway defaults into every conversation.

## Save and verify changes

Settings display inherited and explicit values where supported. Blank password/token fields generally retain existing credentials; use the provided clear action when removal is intended. Listings show masked credential status, not raw values. Eligible admin settings may offer a separately authenticated reveal.

Platform connections can be connected or reconnected without restarting the whole daemon. Runtime/image changes may affect future container starts; inspect the resulting status and verify a real task after a change.

Dashboard sessions are linked to an existing gateway administrator user. Being an approved chat user alone does not grant dashboard access. The shared password alone cannot grant a full dashboard session.

## Related guides

- [Gateway settings](/docs/configuration/gateway-settings)
- [Channel settings](/docs/configuration/channel-settings)
- [Access and users](/docs/configuration/access-and-users)
- [Usage and costs](/docs/features/usage-and-costs)

- [Live sessions](/docs/features/live-sessions)
- [Conversation administration](/docs/features/conversation-administration)
- [User administration](/docs/features/user-administration)
- [Activity and audit](/docs/features/activity-and-audit)
- [Settings search and conflicts](/docs/features/settings-search-and-conflicts)
- [Website and customer portal](/docs/features/website-and-customer-portal)
