---
title: Lean mode and thread Clean
description: Run with a reduced prompt by omitting optional connectors, skills, and injected context.
---

Lean is a conversation option independent of Read-only, Worker, Admin, Auto, and network access. It reduces injected context for tasks that do not need the normal integrations or optional skills. The thread command `/clean` applies a related choice to one thread.

## Enable Lean for a conversation

A conversation manager changes **Lean** in the access settings. In an Admin conversation, Lean applies to ordinary authors; an administrator's foreground turn retains the full context under the gateway's admin exception. Inspect the resolved runtime note for the current attempt rather than assuming a saved switch always produces the same payload.

An effective Clean turn omits injected MCP servers, including gateway control and optional connected apps, optional granted skills, per-author token injection, and injected memory context. The mandatory operating guide and engine baseline capabilities can remain.

Missing tools in this mode are deliberate omissions. Turning Lean off restores normal selection on a later turn; it does not establish that every possible account is configured.

## Make one thread Clean

```text
@ChannelGate /clean Explain this pasted function using only the request.
```

The thread stays Clean on subsequent requests until:

```text
@ChannelGate /clean off
```

Thread Clean also removes gateway provenance and Slack thread-context replay. Moving between bare and normal context clears the prior session, because resuming a session created with the other payload would defeat that context boundary. Use a new thread when you need to preserve the existing conversation independently.

## Keep the permissions distinction clear

Lean changes the supplied context; it does not grant writes, disable network policy, or create direct-host access. Network-off still permits only the configured engine and selected connector routes admitted by the gateway policy. A reduced-context agent cannot call an omitted control MCP tool just because the chat console still has daemon-side controls.

Related: [modes and permissions](/docs/features/permissions), [context and compaction](/docs/features/context-and-compaction), and [MCP configuration](/docs/configuration/mcp-servers).
