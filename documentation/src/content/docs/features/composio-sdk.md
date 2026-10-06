---
title: Enterprise Composio SDK mode
description: Provision reusable user and channel app sessions with the Enterprise Beta integration.
---

ChannelGate supports ordinary credential-backed Composio MCP connections and an optional **Enterprise Composio SDK mode (Beta)**. Missing configuration defaults to Personal mode, preserving existing token resolution on upgrades.

## Enable SDK mode

An administrator opens **Settings → Integrations → Composio connection mode** and selects **SDK — Enterprise · Beta** and supplies an organization Composio SDK API key. An **active Enterprise license** is required. The organization API key remains daemon-side; it is not written into conversation files or given to the model as a credential.

Switching modes does not rewrite or delete credentials saved for the other mode. Return to Personal mode to use its independently stored personal/shared tokens again.

## Understand account isolation

The SDK uses stable external identities for users and channels. Remote MCP session mappings are persisted per thread and access kind, allowing subsequent requests to reuse a session. If the remote session is missing, resolution can recreate it instead of treating its URL as a permanent account identity.

`composio-user` still means the verified requester's routing identity. `composio-agent` means the channel's agent identity, when that surface allows one. Direct messages do not receive a shared agent identity. These names do not prove the owner of a connected inbox or calendar; inspect the selected connection metadata.

## Connect and act deliberately

```text
Check which calendar accounts are already connected for my identity. Use my work account to find the next project meeting.
```

Discovery should use Composio's read-only search-tool inventory before a connection-management action. A new authorization flow is a state change and requires a request to connect the service. Matching service owners do not authorize substituting user and agent identities.

Lean suppresses optional Composio injection. Engine adapters must support the supplied MCP definition, and managed sessions remain authorized by the run capability. SDK provisioning does not override provider scopes, conversation permissions, or the intended identity for sends and writes.

Related: [accounts](/docs/features/connected-accounts), [connections configuration](/docs/configuration/connections), [licensing](/docs/features/licensing), and [account controls](/docs/controls/accounts-and-secrets).
