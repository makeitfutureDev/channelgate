---
title: A dedicated Codex login for a conversation
description: Select a separate Codex account without falling back to another conversation or gateway login.
---

**Enterprise availability.** Dedicated channel Codex authentication requires an effective Enterprise license. The dedicated harness refuses a run after downgrade rather than silently using the shared gateway account; other approved harnesses remain selectable. Shared gateway Codex authentication remains available in other tiers.


A conversation can use the gateway's Codex connection or its own dedicated Codex login. This separates the authentication source for that conversation while leaving Slack and Claude on their existing gateway connections.

## Select the authentication source

An administrator opens the conversation's **Runtime → Codex authentication** settings. Connect the conversation login to use its separately stored Codex authentication. Harness, model and effort controls remain available.

The connected account appears as **Codex (channel account)** (`codex-channel`) alongside gateway **Codex** (`codex`) and other approved harnesses. Successful sign-in selects it as the conversation default. Use the harness selector or `/model` to switch the conversation or one thread. Existing threads retain their session owner until explicitly switched; a switch starts a fresh session with the chat context carried forward.

## Sign in

The administrator chooses a sign-in method:

- **ChatGPT device sign-in:** follow the presented verification link and code. The editor polls the same pending flow, supports cancellation, and selects the dedicated login after success.
- **OpenAI API key:** enter the key in the protected setup field. The gateway sends it to the CLI through standard input; it is not returned in a response or placed on the command line.

Status shows the method and whether sign-in succeeded, without revealing stored credentials. The login directory is tied to the conversation identity. A missing or expired dedicated login does **not** silently use another account.

## Understand what the login governs

The dedicated account supplies authentication only when **Codex (channel account)** is selected, including applicable direct-host administrator turns and its own Codex Cloud MCP discovery. Gateway **Codex** always uses the gateway account. Dedicated sessions and relay identities remain separate during concurrent runs. Channel model and effort choices remain separate settings.

In proxy-mode containers, the host authentication file and refresh token remain outside the container. The runtime receives a channel-bound credential relay; ChatGPT and API-key methods have their corresponding allowed provider routes.

Changing a login affects account usage and available capabilities. Verify the chosen account before treating a setup as complete, and inspect [usage attribution](/docs/features/usage-and-costs) when comparing costs.

Related: [engine authentication](/docs/configuration/engine-authentication), [Codex](/docs/features/codex), and [model picker](/docs/features/model-picker).

The HTTP Run API accepts `"harness": "codex-channel"` (or legacy `"engine": "codex-channel"`) when targeting this conversation. Responses expose both `harness` and `engine`; conflicting aliases are rejected.
