---
title: Slack
description: Connect ChannelGate to Slack and use threads, files, interactive controls, and native reports.
---

Slack is ChannelGate's fully supported chat surface. Talk to the assistant in a direct message, or mention it in a channel or group conversation. Replies arrive in the originating thread, so several projects can run in parallel without sharing one conversation history.

## Connect your workspace

An operator creates a Slack app from the repository's `slack-app-manifest.json` and installs it in the intended workspace. In the admin website, open **Settings → Connection** and enter the bot OAuth token, app-level token, and signing secret. The app-level token needs `connections:write`; Slack Socket Mode carries inbound events without a public webhook.

Use the connection controls under **System** to connect or reconnect Slack. Add the bot to the channel, then approve the intended people under **Users**. Installing the Slack app does not approve every workspace member to use ChannelGate.

## Start a task

```text
@ChannelGate review the README and suggest clearer installation steps.
```

Continue in the reply thread. In a DM, the mention is unnecessary. You can also activate an existing message with the configured reaction; the default is 🤖. The reacting person's current access is checked.

Every AI reply has **Files**, **Variables**, and **Settings** controls. Use these to inspect the conversation workspace, manage environment variables, or change the engine and conversation settings. A live progress card shows what the assistant is doing; the final response includes usage information.

## What Slack supports

Slack provides interactive approvals and clarification forms, streamed answers, file uploads, editable text files, voice intake, tables, charts, Lists, and canvases where the selected tools allow them. Connected Slack account tools are separate from the gateway bot's own controls.

Channel and DM templates can have different permissions. A default new channel starts with Worker, Auto, and network enabled; a default DM starts read-only with network disabled. Administrators can change these templates, so inspect the actual conversation settings before running a task.

## Related guides

- [Conversations](/docs/features/conversations)
- [Threads and sessions](/docs/features/threads-and-sessions)
- [Permissions](/docs/features/permissions)
- [Connections](/docs/configuration/connections)
