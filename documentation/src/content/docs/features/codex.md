---
title: OpenAI Codex
description: Use Codex with thread resume, model controls, skills, and scoped connections.
---

Codex is the second harness. It uses the same conversation authorization, ordinary container boundary, and personal/shared account separation as Claude. Its execution model differs: each turn starts a process and resumes the harness's saved thread when one exists.

## Select Codex

Use `/model` or **Settings → General** to choose the Codex harness for the channel or just the thread. When Codex has more than one usable [license](/docs/features/engine-licenses) in the conversation, the picker then asks for a **License**: **Any license**, or one license with an optional **If it fails, also use** list. A directive also selects and pins the harness:

```text
@ChannelGate codex Implement the validation change and run the relevant checks.
```

Codex model choices come from the selected license's available catalog. Choose a reasoning effort supported by that model, and use **Follow channel default** when you want to remove thread pins.

A new Codex process does not mean a fresh conversation on every reply. ChannelGate stores the thread ID returned by the CLI and resumes it on later turns. `/clear` starts fresh. Codex does not support Claude's `/compact` or warm-process live steering.

## Set up authentication

The operator configures a working Codex login or API credential. This gateway login is the harness's built-in license and is listed as **Default sign-in**. An administrator can choose a dedicated Codex login for the conversation through Runtime → Codex authentication. That login is the license **Codex (channel account)** (`codex-channel`), selectable in that conversation independently of the gateway's `codex` license. Channels and threads can switch licenses; a missing dedicated login never falls back to a different license.

Codex can hold more licenses: the built-in Codex EU license and ChatGPT sign-ins that an administrator adds. An added Codex license is always a ChatGPT sign-in; Codex licenses with an API key cannot be added. See [engine licenses](/docs/features/engine-licenses).

A Codex login is distinct from a human's personal Composio connection. Consult the authentication guide before changing shared login behavior.

In the proxy-backed container runtime, the harness receives access-only authentication with protected placeholders rather than the host's refresh token. Authentication errors identify the configuration that needs repair.

## Plan permissions and integrations

Read-only mode adds the CLI's read-only sandbox. Eligible automatic review depends on the Auto option; headless actions outside the allowed policy can be denied instead of receiving Claude's interactive permission flow. Worker enables the permitted writable workflow.

Organization and channel skills are available through the workspace; personal grants arrive as a private per-run catalog. MCP integrations must have supported, explicitly selected launch definitions. A Claude plugin's commands or hooks are not automatically usable by Codex.

Codex usage costs are estimates from configured rates. Related: [engine licenses](/docs/features/engine-licenses), [models and effort](/docs/features/models-and-effort), [plugins](/docs/features/plugins), [engine authentication](/docs/configuration/engine-authentication), and [engine capabilities](/docs/engines).
