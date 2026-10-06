---
title: Microsoft Teams
description: Set up the Beta Teams connector and understand its conversation, file, and control limitations.
---

Microsoft Teams is a **Beta** connector. It runs the same ChannelGate engines and conversation permissions as Slack, with controls adapted to Teams. Treat a connected status as transport readiness; verify a real message and reply in your tenant before relying on it.

## Configure the connector

Teams needs a public HTTPS endpoint. Set **Settings → Connection → Public URL** to this gateway's public origin, then register the Teams bot against `<public-url>/api/teams/messages`.

The [platform setup reference](/docs/platforms#microsoft-teams-beta) walks through Microsoft's Teams CLI. Create the app in a private operator terminal because registration can print a client secret. Retain the separate Teams app ID for installation; it is different from the bot's Application ID.

In **Settings → Connection → Microsoft Teams**, enter the Application ID, client secret, and tenant ID. Save, connect, install the Teams app, and approve the user's Teams identity under **Users**. Approval of that person's Slack identity does not approve their Teams identity.

## Use conversations

```text
@ChannelGate summarize this week's deployment notes.
```

Personal chats do not need a mention and keep a continuous session. Channel replies thread beneath the triggering message. Group chats are visually flat: new messages begin separate sessions; quote an earlier user message or bot reply to continue its session, and include the bot mention in group quoted replies.

## Beta controls and files

The current beta implementation includes native settings and approval cards, plus private workspace browsing through `/files`. Availability depends on the installed gateway and app revision. Personal-chat file consent requires the app manifest's `supportsFiles` setting; prepared files are limited to 10 MB and consent expires after ten minutes.

Reading group/channel files is opt-in: configure **Read group and channel files from allowed drives**, exact drive IDs, and Microsoft's selected-site application permissions. The checkbox does not grant Microsoft access. Canonical SharePoint links are supported only within the configured drives; sharing shortlinks are unsupported.

Tables, headings, and inline images are simplified for Teams. `/sudo` host threads are Slack-only. Optional all-message edit/reaction observation is experimental and needs separate Graph consent and verification.

## Related guides

- [Chat platform reference](/docs/platforms)
- [Files and editor](/docs/features/files-and-editor)
- [Approvals](/docs/features/approvals)
- [Connections](/docs/configuration/connections)
