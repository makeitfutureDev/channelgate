---
title: MCP servers
description: Select optional tool servers and app groups for each engine and conversation.
---

Model Context Protocol servers provide tools an engine can call. ChannelGate's gateway controls are distinct from optional servers, Composio app identities, and tools included in a granted plugin. A server selected for Claude is not automatically a valid Codex selection.

## Where selections live

Open **Conversations → [conversation] → Cloud MCP** in the admin interface, or the Slack conversation settings' Cloud MCP page. The picker shows the available inventory for the selected engine. Organization and individual grants are also available under **Settings → Access & security → Skills & connectors**.

| Tool source | How it becomes available |
| --- | --- |
| Gateway controls | Supplied by ChannelGate for the authorized run |
| Personal/shared Composio | Configured account identity, not a Cloud MCP checkbox |
| Claude optional servers | Discovered from the configured Claude MCP inventory |
| Codex optional servers and apps | Discovered from the selected Codex login's active runtime inventory |
| Plugin MCP components | Granted, reviewed package with explicitly selected connections |

## Add an optional server to a conversation

1. Have the operator register and authenticate the server for the intended engine using that engine's supported setup. Use the server provider's connection instructions.
2. Open **Cloud MCP**, choose the intended engine, and refresh or reopen the inventory after setup.
3. Select the server or app group this conversation needs and save.
4. Check that its transport and credentials can run in the channel container.
5. Send a small read request in the conversation and confirm the intended tools appear.

An example test request is:

```text
Use the selected documentation server to find the setup instructions
for our example project. Report which server you used.
```

For Codex, connected apps can appear as separate tool groups even when they are delivered by the same underlying app server. Their visibility follows the selected gateway or channel Codex login, so changing the login can change the inventory.

## Container requirements

A stdio server's executable must exist inside the runtime environment; an executable path available only on the host does not become available inside an ordinary container. Worker permissions are required for executable plugin transports. Remote definitions with host-only credentials cannot be assumed safe to reuse automatically: use a supported credential connection instead of pasting authentication into a project's files.

The engine receives an explicit run configuration. Selecting a server does not grant it all host files, enable network access, or bypass tool approvals. Engine compatibility can also restrict which plugin components or transports work.

## Changes and troubleshooting

Saved selections apply to subsequent runs; no daemon restart is normally needed. Discovery is cached, so a newly installed or reauthenticated server may need a refreshed inventory. If an app is missing, check the engine, selected login, connection state, and Lean option before changing access controls.

See [MCP](/docs/features/mcp), [App connections](/docs/configuration/connections), [Plugins](/docs/features/plugins), and [Network policy](/docs/configuration/network-policy).
