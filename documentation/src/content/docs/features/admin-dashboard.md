---
title: Admin dashboard
description: Manage conversations, users, automation, skills, integrations, and operating settings in one web interface.
---

The admin website runs as part of your ChannelGate installation. It manages the gateway and its conversations; it is separate from the public `channelgate.dev` documentation website.

## Sign in

By default, the daemon serves the interface on `http://localhost:4747`. An operator can change the port or put a trusted tunnel/reverse proxy in front of it. On first boot without a configured password, ChannelGate generates an admin password once and stores its hash. Use the password supplied by the installation's operator.

A public deployment should set **Settings → Connection → Public URL** to its reachable HTTPS origin. This also gives approval links a reachable address. Setting Public URL does not create a tunnel or open a firewall.

## Choose the right page

- **Overview:** run, token, cost, model, user, conversation, and skill summaries.
- **Conversations:** work folders, engine settings, access, network, secrets, and grants.
- **Users:** approvals, admin roles, and user-specific configuration.
- **Automations:** recurring tasks and reminders.
- **Activity:** run records and diagnostic events.
- **Skills:** catalog content, revisions, sources, templates, and assignment.
- **API:** examples and status for HTTP-triggered runs.
- **Settings:** gateway-wide connections, agent defaults, container runtime, license, and system controls.
- **System health:** host resource and storage history.

For example, to investigate a failing automation, inspect its schedule in Automations, its conversation settings, and its run in Activity. Change the narrowest applicable setting rather than copying gateway defaults into every conversation.

## Save and verify changes

Settings display inherited and explicit values where supported. Blank password/token fields generally retain existing credentials; use the provided clear action when removal is intended. Listings show masked credential status, not raw values. Eligible admin settings may offer a separately authenticated reveal.

Platform connections can be connected or reconnected without restarting the whole daemon. Runtime/image changes may affect future container starts; inspect the resulting status and verify a real task after a change.

Chat admins and the password-authenticated web session are distinct ways of authorizing control actions. Being an approved chat user does not itself provide the admin website password.

## Related guides

- [Gateway settings](/docs/configuration/gateway-settings)
- [Channel settings](/docs/configuration/channel-settings)
- [Access and users](/docs/configuration/access-and-users)
- [Usage and costs](/docs/features/usage-and-costs)
