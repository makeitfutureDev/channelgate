---
title: Claude Code
description: Use Claude Code for conversational work with warm sessions and approvals.
---

Claude Code is ChannelGate's primary engine. It can read and edit project files, run permitted commands, and use granted tools through the conversation's configured access policy. Ordinary turns execute in the conversation container.

## Select Claude for a task

Open `/model`, choose the scope, and select Claude when it is enabled. You can also begin a request with a thread directive:

```text
@ChannelGate claude Review the implementation and explain the tradeoffs.
```

That directive pins the thread to Claude. **Settings → General** lets you see both channel defaults and thread selections. Model and effort choices come from the engine's supported options rather than a universal list shared with Codex.

Claude supports session resume and context compaction. Eligible warm sessions reuse a live process for quicker follow-ups and steering. A change in author, credentials, or relevant configuration can retire the process, so warm reuse is an optimization rather than a guarantee.

## Configure authentication and tools

An administrator configures the gateway's Claude authentication. The resolver can use a configured setup token, the operator's CLI login, the gateway engine-home login, or an API credential. Standard users do not need to sign into Claude individually merely to send a message.

For an ordinary proxy-backed container turn, ChannelGate relays the resolved access credential without mounting the operator's login store. Expired or missing authentication needs an operator repair; a new chat thread is not a substitute for a valid login.

Grant the skills and MCP connections the task needs. Read-only mode limits tools; Worker permits shell and file writes; Claude can show interactive approval cards for eligible actions. Administrator bypass requires an administrator author in Admin mode.

## Understand usage

The gateway records Claude's reported usage and cost; those figures are not a provider invoice. Explicit thread pins prevent automatic fallback to another engine.

Related: [engine authentication](/docs/configuration/engine-authentication), [models and effort](/docs/features/models-and-effort), [failover](/docs/features/multi-engine-failover), and [engine capabilities](/docs/engines).
