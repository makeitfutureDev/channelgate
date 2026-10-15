---
title: Microsoft 365 access and permissions
description: Understand what the ChannelGate Teams app can access, how Outlook and file connections are authorised, and what to verify before processing sensitive data.
---

Registering the ChannelGate app in your Microsoft 365 tenant does not automatically grant it access to all tenant data. Its Microsoft access depends on the permissions actually granted to the app and any separately connected accounts. Teams messaging, Outlook and file access are separate connections and permission decisions.

This guide explains the current ChannelGate implementation and the Microsoft permission model. It is not an audit of your tenant: review your installed Teams manifest, Microsoft Entra grants and connected accounts before relying on a particular access boundary. The Teams connector is **Beta**, and optional all-message edit/reaction observation is **experimental**.

## Access at a glance

| Connection | What it can access | What controls the boundary |
| --- | --- | --- |
| Teams bot messaging | Messages delivered to the installed bot, conversation/member information used to identify requests, and replies or files exchanged with the bot | Teams installation, bot delivery rules and ChannelGate user/conversation access |
| Optional Teams message reading | Messages in the consented group chat or channels of the consented team, including messages without a bot mention | Resource-specific consent in the Teams app manifest and installation |
| Outlook or calendar tools | Data and actions allowed by the separately connected account and its granted scopes | Connector authorisation, delegated or application permissions, and any Microsoft resource restrictions |
| Optional group/channel file reading | Referenced files in configured drives that the app has Microsoft permission to read | Microsoft selected-resource grants plus ChannelGate's drive allowlist |

## Teams: installed conversations and resource consent

Personal messages to the bot can start work without a mention. In channels and group chats, ordinary requests need a real bot mention. ChannelGate also checks whether the requesting person is approved and permitted to use that conversation before running an agent.

The optional **Observe edits and robot reactions on all messages** setting uses these resource-specific application permissions:

- `ChatMessage.Read.Chat`: read messages in the particular consented chat.
- `ChannelMessage.Read.Group`: read channel messages in the particular consented team.

The team grant covers that team's channels; it is not a permission for just one chosen channel. These grants can include unmentioned messages and allow access without a signed-in user. They do not by themselves grant message access in other teams or chats. Consent is associated with the Teams app installation, so inspect its manifest and installation permissions as well as the Entra application. See [Microsoft's resource-specific consent reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent).

ChannelGate creates Graph subscriptions for known installed conversations when the observation setting is enabled. It uses those events for supported edits and reactions; it does not automatically answer every observed message. **Mention and reaction rules control when an agent runs; they do not narrow Microsoft's read permission.** Disabling the observation setting does not revoke a previously granted Microsoft permission.

For stronger separation, install and consent the app in a dedicated team containing only material intended for this integration. Verify real message delivery and resource consent in your tenant using the [Teams setup reference](/docs/platforms#optional-all-message-edit-and-reaction-events-experimental).

## Outlook: a separate authorised account

Installing the Teams app does not connect Outlook. Email and calendar tools require their own authorised connection, which may use a different application registration and provider from the Teams bot.

For delegated access, the connector acts on behalf of the connected user within the granted scopes and that user's access. For example, delegated `Mail.Read` allows reading that user's mailbox; `Mail.Read.Shared` can also include shared mail the user can access. Read/write and send are distinct permissions, so review each requested scope. A user-scoped connection can still expose a substantial amount of sensitive data inside the permitted mailbox. See [Microsoft's mail permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference#mailread).

Application permissions work differently. For example, application `Mail.Read` can cover all tenant mailboxes unless access is restricted in Microsoft. Do not describe an application connection as user-scoped merely because an administrator authorised it. Microsoft supports [Exchange application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac) for resource-scoped access; your administrator must verify the effective grants, including any other grants that broaden access.

In ChannelGate, `composio-user` routes to the active requester's connection; `composio-agent` routes to the shared conversation or organisation connection. These are account-routing roles, not Microsoft permission scopes. A shared connection makes its granted capabilities available to authorised work using that identity. Confirm the service account owner, connector provider and consented scopes before connecting sensitive mailboxes. See [personal and shared accounts](/docs/features/connected-accounts).

## SharePoint, OneDrive and files supplied to the bot

Group/channel file reading is opt-in. Under **Settings → Connection → Microsoft Teams**, enable **Read group and channel files from allowed drives** and enter the approved drive IDs. This setting accepts up to 32 drives and does not grant Microsoft permissions.

Separately, configure the app's Microsoft read access to the intended resources. Selected permissions, such as `Sites.Selected`, require consent and an explicit resource assignment. Site-level access covers the selected site, while ChannelGate's file resolver additionally checks the configured drive boundary. See [Microsoft's selected permissions overview](https://learn.microsoft.com/en-us/graph/permissions-selected-overview).

The current resolver accepts supported file references and canonical SharePoint URLs within configured drives, validates the returned file identity, and refuses unsupported sharing shortlinks. This allowlist applies across authorised conversations in the gateway; it does not check each requesting person's own Microsoft file entitlement. Other file connectors have their own grants, and a broader Microsoft grant is not reduced by this resolver's allowlist.

A file uploaded directly in a personal chat is a separate flow: the bot can process the supplied attachment without needing a tenant-wide file-reading grant. Native delivery of a prepared file uses Teams file consent. See [Microsoft's bot file guidance](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) and the [ChannelGate Teams guide](/docs/features/microsoft-teams).

## Sensitive data and processing location

Content retrieved from a permitted mailbox, file or conversation may become part of the agent's prompt and be sent to the selected AI provider. Work files, conversation history and memory also have their own local persistence, and connectors may introduce additional service providers. Access permissions and processing location are separate questions.

Hosting ChannelGate on an EU server does not by itself place AI inference or connector processing in the EU. Verify the actual engine endpoint, provider account and contractual region commitments, including fallback behaviour. An ordinary Claude or Codex login does not establish EU processing. The [engine authentication guide](/docs/configuration/engine-authentication#choose-a-login-for-work-in-europe) distinguishes currently available routes from routes still in development.

Scoped permissions and EU hosting alone do not establish GDPR compliance. Review the intended data, permitted users, provider and connector terms, retention and processing arrangements with your organisation's responsible privacy team. See [privacy and data flow](/docs/privacy) for what leaves the host and what is stored locally.

## Verify your deployment

Before enabling sensitive-data workflows, review these boundaries with your Microsoft 365 administrator:

1. Inspect the actual Teams manifest, installation consent and Entra API grants. Check for broader grants in addition to the resource-specific permissions described here.
2. Confirm the installed chats/teams and whether all-message observation is enabled. Record that a team read grant covers its channels.
3. Inspect each Outlook/calendar connector's account owner, application, scopes and permission type. Test the intended access and a resource that should be inaccessible.
4. Verify selected file-resource assignments and the drive allowlist. Test an allowed file and a file outside that boundary.
5. Confirm ChannelGate user admission, conversation access, personal/shared account routing and enabled tools.
6. Verify AI and connector processing arrangements, storage/retention and revocation procedures. A successful connection indicator is not evidence that these checks passed.

## Related guides

- [Microsoft Teams setup and limitations](/docs/features/microsoft-teams)
- [Connected account configuration](/docs/configuration/connections)
- [Modes and permissions](/docs/features/permissions)
- [Variables and secrets](/docs/features/secrets)
- [Privacy and data flow](/docs/privacy)
