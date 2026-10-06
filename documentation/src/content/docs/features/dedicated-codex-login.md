---
title: A dedicated Codex login for a conversation
description: Select a separate Codex account without falling back to another conversation or gateway login.
---

A conversation can use the gateway's Codex connection or its own dedicated Codex login. This separates the authentication source for that conversation while leaving Slack and Claude on their existing gateway connections.

## Select the authentication source

An administrator opens the conversation's **Runtime → Codex authentication** settings. Choose the gateway login to retain the usual engine, model, and effort controls. Choose the conversation login to use its separately stored Codex authentication.

A dedicated login fixes the conversation to **Codex**. Redundant engine controls disappear, and the Slack model picker goes from scope directly to Codex model and effort. Existing Claude threads move to a fresh Codex session on their next turn; their Claude session ID cannot be resumed by Codex.

## Sign in

The administrator chooses a sign-in method:

- **ChatGPT device sign-in:** follow the presented verification link and code. The editor polls the same pending flow, supports cancellation, and selects the dedicated login after success.
- **OpenAI API key:** enter the key in the protected setup field. The gateway sends it to the CLI through standard input; it is not returned in a response or placed on the command line.

Status shows the method and whether sign-in succeeded, without revealing stored credentials. The login directory is tied to the conversation identity. A missing or expired dedicated login does **not** silently use another account.

## Understand what the login governs

The selected account supplies Codex authentication for the conversation's normal turns, applicable direct-host administrator turns, and Codex Cloud MCP discovery. Channel model and effort choices remain separate settings.

In proxy-mode containers, the host authentication file and refresh token remain outside the container. The runtime receives a channel-bound credential relay; ChatGPT and API-key methods have their corresponding allowed provider routes.

Changing a login affects account usage and available capabilities. Verify the chosen account before treating a setup as complete, and inspect [usage attribution](/docs/features/usage-and-costs) when comparing costs.

Related: [engine authentication](/docs/configuration/engine-authentication), [Codex](/docs/features/codex), and [model picker](/docs/features/model-picker).
