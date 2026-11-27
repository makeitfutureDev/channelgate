---
title: A dedicated Codex login for a conversation
description: Give one conversation its own Codex license that never falls back to another conversation or gateway login.
---

**Enterprise availability.** Dedicated channel Codex authentication requires an effective Enterprise product license. The dedicated Codex license refuses a run after downgrade rather than silently using the shared gateway login; other approved licenses remain selectable. Shared gateway Codex authentication remains available in other tiers.


A conversation can use the gateway's Codex connection or its own dedicated Codex login. This separates the authentication source for that conversation while leaving Slack and Claude on their existing gateway connections. The dedicated login is a built-in [license](/docs/features/engine-licenses) of the Codex harness that exists only in the conversation that signed it in.

## Select the authentication source

An administrator opens the conversation's **Runtime → Codex authentication** settings. Connect the conversation login to use its separately stored Codex authentication. Harness, license, model and effort controls remain available.

The connected login appears as the Codex license **Codex (channel account)** (`codex-channel`) alongside the gateway's Codex license (`codex`, listed as **Default sign-in**) and the other licenses the conversation may use. Successful sign-in selects it as the conversation default. Use the **License** control or `/model` to switch the conversation or one thread, or select it together with other Codex licenses through **Any license** or **If it fails, also use**. Existing threads retain their session owner until explicitly switched; a switch starts a fresh session with the chat context carried forward.

## Sign in

The administrator chooses a sign-in method:

- **ChatGPT device sign-in:** follow the presented verification link and code. The editor polls the same pending flow, supports cancellation, and selects the dedicated login after success.
- **OpenAI API key:** enter the key in the protected setup field. The gateway sends it to the CLI through standard input; it is not returned in a response or placed on the command line.

Status shows the method and whether sign-in succeeded, without revealing stored credentials. The login directory is tied to the conversation identity. A missing or expired dedicated login does **not** silently use another license. A turn moves on from it only when the conversation's selection names further Codex licenses.

## Understand what the login governs

The dedicated login supplies authentication only when **Codex (channel account)** is the license running the turn, including applicable direct-host administrator turns and its own Codex Cloud MCP discovery. The gateway's Codex license always uses the gateway login. Dedicated sessions and relay identities remain separate during concurrent runs. Channel model and effort choices remain separate settings.

In proxy-mode containers, the host authentication file and refresh token remain outside the container. The runtime receives a channel-bound credential relay; ChatGPT and API-key methods have their corresponding allowed provider routes.

Changing a login affects account usage and available capabilities. Verify the chosen account before treating a setup as complete, and inspect [usage attribution](/docs/features/usage-and-costs) when comparing costs.

Related: [engine licenses](/docs/features/engine-licenses), [engine authentication](/docs/configuration/engine-authentication), [Codex](/docs/features/codex), and [model picker](/docs/features/model-picker).

The HTTP Run API accepts `"harness": "codex-channel"` (or legacy `"engine": "codex-channel"`) when targeting this conversation; the field names the license the run starts on. Responses expose both `harness` and `engine`; conflicting aliases are rejected.
