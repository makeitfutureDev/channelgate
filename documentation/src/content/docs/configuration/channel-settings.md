---
title: Channel settings
description: Configure one conversation's tools, runtime, workspace, skills, and access.
---

Each ChannelGate conversation has its own settings. A conversation can be a Slack channel, group, DM, or a supported conversation on another platform. Threads share that conversation's workspace and permissions, while a thread can have its own engine session and runtime selection.

## Where to configure

In the admin interface, open **Conversations**, select a conversation, and use its settings tabs. On Slack, open **Settings** from a reply's footer to see the settings available to you. The Slack modal distinguishes channel settings from **this thread** runtime controls.

| Setting or tab | Purpose |
| --- | --- |
| Access | Read-only, Worker, or Admin mode; Auto, Lean, network, user and manager policies |
| MCP Connections | Conversation-level shared connections and token fallback preferences |
| Cloud MCP | Additional servers or app groups selected separately for each engine |
| Environment | Write-only variables for this conversation |
| Skills | Explicit skill grants and the followed skill template |
| Runtime | Engine, model, effort, working folder, and related runtime options |
| Instructions | Standing instructions specific to the conversation |
| Memory | Conversation memory and review information |

## Configure a project conversation

1. Approve the people who will use the bot and choose the conversation's access policy.
2. Choose **Worker** if the agent needs to edit files or run commands. Turn **Auto** on only when you intend to automatically approve tool requests.
3. Choose the engine and model, or leave the engine at **Default (global setting)** to inherit the gateway default.
4. Select a relevant skill template and add project-specific skills.
5. Configure the necessary app connections or environment variables in this conversation's scope.
6. Save the conversation settings, then send a small test request in a fresh thread.

For example, a project instruction can say:

```text
This conversation maintains the example-store project.
Read AGENTS.md before changing code. Use staging for deployment checks.
Record durable project decisions in this conversation's memory.
```

Do not paste credentials into instructions. Use **Environment** or the relevant connection control.

## Workspace and save behavior

**Working folder** accepts a custom path; blank uses the default conversation folder. **Browse…** helps an administrator select an existing folder. Saving a new path changes the workspace used by future runs; existing files remain where they were. **Reset to default** changes the selection after saving, without copying the old project's files.

Most saved conversation changes apply on the next message. Secrets and Codex sign-in controls have their own save actions. Existing threads can retain engine sessions and thread pins, so use a fresh thread when checking inherited defaults.

## Who can change what

Gateway admins can manage conversation access. Delegated channel managers can use the Slack Access settings allowed by the management policy, but cannot make themselves organization admins. Runtime changes have a separate organization policy. Conversation skill assignments are available to members; organization templates remain admin-managed.

See [Permissions](/docs/features/permissions), [Models and effort](/docs/features/models-and-effort), [Shared workspaces](/docs/features/shared-workspaces), and [Environment variables](/docs/configuration/environment-variables).
