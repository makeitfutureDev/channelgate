---
title: OpenCode proof adapter
description: Use the restricted third engine only for admitted read-only, network-off work.
---

OpenCode is a proof engine adapter with a deliberately narrow admission profile. It is outside the normal Claude↔Codex failover graph and is not bundled as an installed CLI in the standard conversation image.

## Choose a supported task

A suitable request is an analysis of files already inside the conversation workspace:

```text
Explain the relationships among these modules and identify duplicated logic.
Read existing files only; do not run shell commands or fetch websites.
```

The operator must provide an appropriate OpenCode CLI and provider setup, enable the engine, and select a **Read-only, network-off** runtime. An engine selection alone does not make an unsupported runtime admissible.

Model IDs retain their provider boundary, such as `provider/model`; exact availability depends on the configured installation. Refer to the local engine catalog and operator setup rather than assuming a particular provider is connected.

## Understand what is supported

| Capability | Proof adapter |
| --- | --- |
| Workspace-local read, glob, grep, list | Admitted |
| JSON text events, session identity, resume | Supported |
| Cancellation, health/version, usage | Supported |
| Shell, editing, model web actions | Refused |
| MCP, external plugins, subagents, skills | Omitted or refused |
| Admin bypass and writable profiles | Refused before spawn |

The inline policy defaults to denial, permits only the admitted workspace read actions, and excludes `.env` reads. Plugin suppression prevents external plugin loading. It receives no gateway, Composio, or skills credential bundle.

## Keep the runtime boundary

Like ordinary Claude or Codex work, the process runs through the conversation's rootless container target. OpenCode's tool policy limits actions inside that boundary; it is not a substitute for operating-system isolation. The network-off setting is enforced by the egress proxy in the supported proxy runtime; legacy bridge networking has different enforcement properties.

Use [Claude](/docs/features/claude-code) or [Codex](/docs/features/codex) for the supported writing and integrated-tool workflows. The [engine capability reference](/docs/engines) describes the common contract and [compatibility](/docs/compatibility) describes the image.
