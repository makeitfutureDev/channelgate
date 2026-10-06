---
title: MCP integrations
description: Connect the agent to approved external tool servers.
---

Model Context Protocol (MCP) servers expose tools the agent can call: searching a service, reading a record, or carrying out an authorized action. ChannelGate assembles each run's selected servers rather than exposing every integration installed on the host.

## Select a connection for the conversation

Administrators configure the native engine MCP inventory and assign optional connections through **Cloud MCP**. Conversation settings separate these selected servers from built-in gateway controls and credential-backed Composio, Toolbox, and Make connections.

A typical workflow is:

1. Configure the server endpoint and its supported authentication.
2. Grant the server to the intended conversation and engine.
3. Start a new request and have the agent discover the available tools.

```text
@ChannelGate Use the connected project-management tools to find open tasks for this customer.
```

A grant selects the server; it does not authorize every possible write. The request, channel permissions, connected account privileges, and approval policy still govern each action.

## Choose a supported transport

Claude supports selected HTTP and stdio connections through protected per-run configuration. Codex uses explicit per-run definitions and protected credential handling for managed integrations. An optional server without a complete compatible launch definition is refused with a reason.

Qwen harnesses share Claude's Cloud MCP selections because they use the same CLI transport. The OpenCode proof adapter has no MCP support. Plugin servers also require explicit compatible grants and do not inherit arbitrary authentication from plugin source files.

## Troubleshoot a missing tool

Check the effective engine, conversation grant, saved credential, and server health. Read/search discovery should establish what the selected identity actually has connected before creating a new authorization flow. Lean deliberately suppresses optional connections, so check it before concluding an integration is disconnected.

The ordinary container's outbound requests follow network policy; header-bearing managed remote connections can be relayed by the daemon without placing their credentials in the container. This is not a grant to unrelated host tools.

Related: [MCP server configuration](/docs/configuration/mcp-servers), [connected accounts](/docs/features/connected-accounts), [network policy](/docs/configuration/network-policy), and [engine capabilities](/docs/engines).

## Reference and specialized connections

- [Engine-specific MCP connection controls](/docs/controls/mcp-connections)
- [External skills library endpoint](/docs/features/skills-library-mcp)
- [Enterprise Composio SDK mode](/docs/features/composio-sdk)
- [Toolbox and Make connections](/docs/features/toolbox-and-make)
