---
title: MCP connection controls
description: Discover and manage engine-specific optional tool servers in a conversation.
---

These controls select servers already available through the active engine inventory. Configure server definitions and authentication using the supported native engine configuration and Cloud MCP assignment paths; there is no separate general-purpose MCP catalog editor in the admin UI.

## list_available_mcps

Discover the current engine’s host-configured MCP inventory.

**Arguments:** none.

**Authority and scope:** Current admitted conversation and active engine.

**Result:** Server names and offline indicators.

**Restrictions:** Codex discovery uses the channel authentication scope when codexAuthSource is channel. Does not activate servers or prove account ownership.

## list_channel_mcps

Show optional MCP selections for the active engine.

**Arguments:** none.

**Authority and scope:** Current conversation, active engine.

**Result:** Selected server names or a no-extra-servers message.

**Restrictions:** Engine-specific selection; built-in gateway and credential-backed connections are separate from this list.

## add_channel_mcps

Allow configured named servers in this conversation.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `names` | Yes | Array of server names from list_available_mcps. |

**Authority and scope:** Channel manager or administrator; normal control-plane approval policy.

**Result:** New selections and unknown/refused names.

**Restrictions:** Matches names case-insensitively. Only discovered servers with a supported persistable definition are saved. Conversation must exist; applies on next message. Does not grant arbitrary writes on the server.

## remove_channel_mcps

Remove the active engine’s optional selections.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `names` | Yes | Array of server names, matched case-insensitively. |

**Authority and scope:** Channel manager or administrator; normal control-plane approval policy.

**Result:** Removed count and remaining allowed names.

**Restrictions:** Does not remove built-in controls or credentials. Other engines’ separate selections remain. Applies next message.

## Related guides

[MCP integrations](/docs/features/mcp), [server configuration](/docs/configuration/mcp-servers), [engine capabilities](/docs/engines), and [connected accounts](/docs/features/connected-accounts).
