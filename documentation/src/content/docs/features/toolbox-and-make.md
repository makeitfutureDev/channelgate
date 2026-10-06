---
title: Toolbox and Make connections
description: Use optional credential-backed tool servers without mixing account scopes.
---

ChannelGate can inject optional **makeitfuture-toolbox** and **make-toolbox** MCP connections when their credentials and endpoints are configured. They are separate from Composio identities and from individually selected Cloud MCP servers.

## Configure the intended server

A Toolbox access token can be personal, conversation-specific, or an organization default. Resolution follows **conversation → person → organization**, choosing the most specific available token. The requesting person's token belongs to that verified person and is not supplied to another author's request.

A Make toolbox connection needs both its URL and key in conversation settings. The endpoint is normalized and validated before the pair is saved. Configure credentials through private fields rather than posting them in a shared message.

Personal Toolbox tokens can also be set or cleared using the account controls. If a token-entry chat tool is used, send it in a DM and delete the source message after saving; the saved response never repeats the token. Prefer the private form when available.

## Discover the actual capabilities

```text
Inspect the connected Make toolbox tools and identify the available read-only execution inspection tools for this scenario.
```

The connected server determines its tool inventory. A Toolbox token does not prove which organization, apps, or records it can reach. Discover metadata and actual permissions before promising an operation.

An authorized read of a scenario is distinct from changing or running it. Workflow edits and external state changes still require the user's intended action, correct account, and the channel's permission/approval policy.

## Troubleshoot missing tools

Check the endpoint/key pair, the selected credential scope, server health, and current engine support. Lean suppresses these optional connections. Managed header-bearing remote servers are relayed by the daemon in containers so their real credentials do not need to appear in a per-run file.

These integrations are optional; a general ChannelGate installation does not include a private organization's toolbox or business skill catalog automatically.

Related: [connections configuration](/docs/configuration/connections), [MCP](/docs/features/mcp), [accounts](/docs/features/connected-accounts), and [account controls](/docs/controls/accounts-and-secrets#set_my_toolbox_token).
