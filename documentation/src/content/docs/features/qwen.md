---
title: Qwen provider harnesses
description: Configure opt-in Anthropic-compatible providers through the Claude Code CLI.
---

Qwen harnesses run the Claude Code CLI against a separately configured Anthropic-compatible provider. They are opt-in alternatives to the main Claude and Codex engines, with their own credentials, endpoints, and model catalogs.

## Enable and configure a provider

An administrator opens **Settings → Engine & runtime → Harnesses the gateway may use** and enables the desired harness. Missing enablement means off: upgrading ChannelGate does not automatically activate a Qwen provider.

The current harnesses are **Qwen (Claude Code)**, identified as `qwen`, and **Qwen EU (Claude Code)**, identified as `qwen-eu`. Each provider card has its own API key, endpoint, and default model. Qwen EU uses an account-specific workspace endpoint and ships no default endpoint; both a key and the correct URL must be configured.

Then select the enabled harness in `/model` or the channel's runtime settings:

```text
@ChannelGate qwen-eu Summarize the implementation options in this repository.
```

The named harness becomes the thread's selection. A provider's offered catalog can include text models outside the Qwen family; the UI shows the discovered account catalog or explains when a fallback list is being used.

## Understand the execution differences

These harnesses preserve the CLI's tool loop, permission controls, MCP configuration, skills, and cold session resume. They share Claude's selected Cloud MCP connections. They do not reuse warm processes, preventing a stale provider environment from surviving a credential or harness change.

Qwen credentials never fall back to the operator's Anthropic login. The providers are outside automatic Claude↔Codex failover in both directions. Errors require repairing that provider's configuration or deliberately choosing another engine.

## Check the limits

Usage records retain token counts without an invented dollar amount; the CLI's Anthropic-priced cost is discarded. Provider keys currently reach the engine as raw credentials rather than proxy placeholders. Proxy mode rejects private-address provider endpoints, including self-hosted endpoints on private networks.

OpenCode is a separate proof adapter, restricted to read-only, network-off work; it is not an equivalent full-capability provider choice. See [engine capabilities](/docs/engines), [engine authentication](/docs/configuration/engine-authentication), and [network policy](/docs/configuration/network-policy).
