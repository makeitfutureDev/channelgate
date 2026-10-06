---
title: OpenAI Codex
description: Use Codex with thread resume, model controls, skills, and scoped connections.
---

Codex is an alternative engine that uses the same conversation authorization, ordinary container boundary, and personal/shared account separation as Claude. Its execution model differs: each turn starts a process and resumes the engine's saved thread when one exists.

## Select Codex

Use `/model` or **Settings → General** to choose Codex for the channel or just the thread. A directive also selects and pins it:

```text
@ChannelGate codex Implement the validation change and run the relevant checks.
```

Codex model choices come from its available catalog. Choose a reasoning effort supported by that model, and use **Follow channel default** when you want to remove thread pins.

A new Codex process does not mean a fresh conversation on every reply. ChannelGate stores the thread ID returned by the CLI and resumes it on later turns. `/clear` starts fresh. Codex does not support Claude's `/compact` or warm-process live steering.

## Set up authentication

The operator configures a working Codex login or API credential. An administrator can choose a dedicated Codex login for the conversation through Runtime → Codex authentication. That choice fixes the channel and its threads to Codex and does not fall back to a different account if the dedicated login is missing. It is distinct from a human's personal Composio connection. Consult the authentication guide before changing shared login behavior.

In the proxy-backed container runtime, the engine receives access-only authentication with protected placeholders rather than the host's refresh token. Authentication errors identify the configuration that needs repair.

## Plan permissions and integrations

Read-only mode adds the CLI's read-only sandbox. Eligible automatic review depends on the Auto option; headless actions outside the allowed policy can be denied instead of receiving Claude's interactive permission flow. Worker enables the permitted writable workflow.

Organization and channel skills are available through the workspace; personal grants arrive as a private per-run catalog. MCP integrations must have supported, explicitly selected launch definitions. A Claude plugin's commands or hooks are not automatically usable by Codex.

Codex usage costs are estimates from configured rates. Related: [models and effort](/docs/features/models-and-effort), [plugins](/docs/features/plugins), [engine authentication](/docs/configuration/engine-authentication), and [engine capabilities](/docs/engines).
