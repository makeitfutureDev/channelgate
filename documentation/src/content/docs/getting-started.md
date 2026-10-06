---
title: Your first conversation
description: Connect Slack, approve a user, and start your first ChannelGate agent turn.
---

Start with one channel and a small task. This walkthrough assumes ChannelGate is installed on your Linux host. If it is not, follow the [installation guide](/docs/installation) first.

## Connect Slack

1. Create a Slack app from the repository’s [app manifest](https://github.com/makeitfutureDev/channelgate/blob/beta/slack-app-manifest.json).
2. Generate an app-level token with `connections:write`, install the app, and copy its bot token and signing secret.
3. Open your instance-local admin UI, normally `http://localhost:4747`, and add the three tokens under **Settings → Connection**.
4. Save and connect. Confirm the status shows your app and workspace.

The [installation guide](/docs/installation) describes these steps in detail. Microsoft Teams and Google Chat have different setup requirements and remain in [Beta](/docs/platforms).

## Approve the first user

Approve the person in the admin UI and invite the bot to your Slack channel. A channel’s access policy decides who can use it; named guest grants add specific exceptions.

In channels and groups, mention the bot to start a turn. In a direct message, an approved user can speak without a mention.

## Send a small task

For a first read-only turn, try:

> @your-bot Explain the files in this workspace and summarize what you can help our team with.

The first turn provisions the conversation’s work folder and container, then starts an engine session for the thread. Follow-up messages in that thread resume the same session. A different thread starts its own session while sharing the conversation’s work folder and memory.

## Choose the conversation’s tools

Read-only mode supports inspection. Worker mode adds shell and file writes in the resolved runtime. Admin mode gives ordinary members Worker tools and permits broader tools for an admin author.

Auto, Lean, and network access are separate settings. Read [engines and permissions](/docs/engines) before widening access or adding credentials.

## Add a key when you need more conversations

A new installation can evaluate one conversation with up to 500 AI messages per UTC month. A free organization key opens unlimited conversations with 500 messages each; Enterprise removes the message cap. See [license keys and limits](/docs/licensing).

## Continue

- [Skills and plugins](/docs/skills) — give the agent reusable workflows.
- [Privacy and data flow](/docs/privacy) — review what stays on your host and what reaches providers.
- [Operations](/docs/operations) — maintain containers, backups, and updates.
