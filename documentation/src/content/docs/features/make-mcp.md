---
title: Make connections
description: Use optional credential-backed tool servers without mixing account scopes.
---

ChannelGate can inject a **make-toolbox** MCP connection when its URL and key are configured. It is separate from Composio identities and from individually selected Cloud MCP servers.

## Configure the intended server


A Make toolbox connection needs both its URL and key in conversation settings. The endpoint is normalized and validated before the pair is saved. Configure credentials through private fields rather than posting them in a shared message.


## Discover the actual capabilities

```text
Inspect the connected Make toolbox tools and identify the available read-only execution inspection tools for this scenario.
```

The connected server determines its tool inventory. A connection does not prove which organization, apps, or records it can reach. Discover metadata and actual permissions before promising an operation.

An authorized read of a scenario is distinct from changing or running it. Workflow edits and external state changes still require the user's intended action, correct account, and the channel's permission/approval policy.

## Troubleshoot missing tools

Check the endpoint/key pair, the selected credential scope, server health, and current engine support. Lean suppresses these optional connections. Managed header-bearing remote servers are relayed by the daemon in containers so their real credentials do not need to appear in a per-run file.

This integration is optional. Configure the intended Make server explicitly.

Related: [connections configuration](/docs/configuration/connections), [MCP](/docs/features/mcp), [accounts](/docs/features/connected-accounts), and [account controls](/docs/controls/accounts-and-secrets).
