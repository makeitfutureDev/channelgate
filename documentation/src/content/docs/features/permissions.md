---
title: Permissions and modes
description: Choose Read-only, Worker, or Admin and configure Auto, Lean, and conversation access.
---

Permissions determine what an assistant may do in a conversation. Conversation access determines who may use it. Configure both: granting someone access to a powerful channel also grants them the tools available to an ordinary member of that channel.

## Choose a mode

Open the conversation in the admin website, or **Settings → General Settings** from a Slack reply.

- **Read-only** permits ordinary inspection. Changes and commands outside the allowed policy need approval.
- **Worker** permits commands and file edits in the conversation's container and mounted workspace, while unusual actions can still require approval.
- **Admin** gives current organization admins all tools without permission prompts. Other admitted members receive Worker behavior with the selected Auto and Lean options.

Only an administrator can enable Admin mode. Admin mode does not by itself execute on the host or grant Linux root access.

## Configure the independent switches

**Auto** automatically approves tool requests for conversation members. Enabling Auto from Read-only also enables Worker; choosing Read-only clears Auto.

**Lean** removes optional skills and connectors to reduce injected context. In Admin mode, an admin author's turn retains full context even when Lean is enabled. **Network** is a separate switch and does not change just because the mode changes.

For a review-only channel, choose Read-only and leave network off. For a development channel, choose Worker and allow network if package downloads or public APIs are needed. Inspect Auto before delegating changes that should require human review.

## Who can use and manage it

The default channel access policy admits organization-approved users and admins. A channel can instead restrict automatic access to admins or require named grants. Channel managers control the access settings; the default management policy is admins. User approval is still required for ordinary DMs.

New channel templates default to Worker + Auto + network on; new DM templates default to Read-only + network off. Operators can customize templates, and existing conversations retain their saved settings.

An optional operator-home mount is configured separately under **Container runtime**. It broadens visibility for admitted members and makes non-admin turns read-only; inspect its actual state before assuming normal workspace confinement.

## Related guides

- [Access and users](/docs/configuration/access-and-users)
- [Approvals](/docs/features/approvals)
- [Container isolation](/docs/features/container-isolation)
- [Network access](/docs/features/network-access)
