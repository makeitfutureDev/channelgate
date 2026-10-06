---
title: App connections
description: Configure personal and shared connected accounts and choose the correct identity for a task.
---

Connected apps give an agent access to services such as email, calendars, drives, and issue trackers. ChannelGate keeps the requesting person's app identity separate from the agent's shared identity. An available connector does not establish which service account owns it or authorize every write that account can perform.

## Choose the scope

| Scope | Configuration location | Effective identity |
| --- | --- | --- |
| Personal | A user's account controls; admin **Users** drawer also manages their token | `composio-user`, only on that person's runs |
| Conversation | **Conversations → MCP Connections** | `composio-agent` for that conversation |
| Organization default | **Settings → Integrations** | Shared identity when a conversation has no overriding token |

In Personal connection mode, the agent's Composio token resolves **conversation → organization default**. The requester's personal token remains separate. Shared Composio is suppressed in one-to-one DMs, where the requesting person's connection is the relevant identity.

The Toolbox integration has its own token chain: **conversation → active user → organization default**. Do not assume that every connector uses Composio's scope rules.

## Configure a shared app identity

1. Open **Settings → Integrations → Composio connection mode** and check which mode the deployment uses.
2. For Personal mode, configure the intended shared Composio token either for this conversation or as the organization default.
3. Keep endpoint settings pointed at the intended integration service; changing a URL does not migrate accounts.
4. Save the configuration, then ask the agent to inspect the connection status and account metadata for the relevant service.
5. Test a read before asking for a write. Name the intended account in the write request.

For example:

```text
Check which calendar account is connected as my personal identity.
Then list my events for tomorrow.
```

For a shared task, name the account: “Create this task using the team's connected issue tracker.” If both identities offer that service, the account selection must be resolved before changing its state.

## Enterprise SDK mode

SDK mode is an **Enterprise / Beta** option configured with a separate SDK API key. It uses managed Composio sessions rather than independently supplied Personal-mode tokens. Switching the mode retains the stored tokens but makes those tokens inactive while SDK mode is selected. Review the resulting session identities instead of assuming the previous shared account remains selected.

## Save effects and limitations

Connections are assembled for each run, so saved token and selection changes apply to subsequent messages without restarting the daemon. Lean mode can suppress optional connectors. A server's appearance in a picker does not prove its login works; test the actual intended identity.

Only deployment admins change organization defaults. Personal account settings do not grant access to other users' personal connections.

See [Connected accounts](/docs/features/connected-accounts), [MCP servers](/docs/configuration/mcp-servers), [Plugins](/docs/features/plugins), and [Environment variables](/docs/configuration/environment-variables).
