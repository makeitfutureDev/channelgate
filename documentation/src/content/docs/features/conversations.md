---
title: Conversations
description: Start agent work in channels, direct messages, and team chat.
---

ChannelGate gives each conversation a persistent place to work: its own working folder, container home, settings, and memory. Threads inside the conversation keep separate engine sessions while using that shared workspace.

## Start work in the right conversation

In Slack, invite the bot to a channel and mention it in the message you want it to answer. In a direct message, send the request without a mention. A configured reaction trigger can also bring the agent into an existing message; the default is 🤖.

```text
@ChannelGate Review the attached proposal and list questions for the customer.
```

Continue in the resulting thread so follow-up requests resume its context. Start a new thread for an independent task. Bringing the agent into a discussion does not make it answer every later unmentioned channel message.

Slack is the generally available chat surface. Microsoft Teams and Google Chat are Beta and have different threading, attachment, and interactive-control capabilities. Read the [platform setup guide](/docs/platforms) before assuming Slack buttons will be available elsewhere.

## Configure access and behavior

Open **Settings** from a Slack reply or find the conversation in the admin web UI. Its engine, model, permission mode, network access, skills, connections, and memory settings determine what the agent can do.

An invitation or mention does not grant authorization. Direct messages require an administrator or approved user; channel policy and explicit guest grants determine channel access. Settings changes have their own authority checks, and enabling Admin mode requires an administrator.

## Keep project context together

Use a customer channel for that customer's files, recurring instructions, and shared work. Two threads in that channel can discuss different tasks but still see the same project files. Separate conversations are the default way to separate unrelated workspaces.

Next: [threads and sessions](/docs/features/threads-and-sessions), [shared workspaces](/docs/features/shared-workspaces), and [access and users](/docs/configuration/access-and-users).
