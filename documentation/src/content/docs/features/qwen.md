---
title: Qwen provider licenses
description: Configure opt-in Anthropic-compatible provider licenses for the Claude Code harness.
---

The Qwen licenses run the Claude Code harness against a separately configured Anthropic-compatible provider. They are built-in [licenses](/docs/features/engine-licenses) of Claude Code, not separate harnesses: each has its own credential, endpoint, and model catalog. They are off until an administrator switches them on.

## Enable and configure a provider

An administrator opens **Settings → Agent defaults → Engine & runtime** and switches on the desired license. Missing enablement means off: upgrading ChannelGate does not automatically activate a Qwen provider.

The current licenses are **Qwen (Claude Code)**, identified as `qwen`, and **Qwen EU (Claude Code)**, identified as `qwen-eu`. Each provider card has its own API key, endpoint, and default model. Qwen EU uses an account-specific workspace endpoint and ships no default endpoint; both a key and the correct URL must be configured.

Then select the Claude Code harness and the Qwen license in `/model` or the channel's runtime settings. A message can also start with the license's identifier:

```text
@ChannelGate qwen-eu Summarize the implementation options in this repository.
```

The named license becomes the thread's selection. A provider's offered catalog can include text models outside the Qwen family; the UI shows the discovered account catalog or explains when a fallback list is being used.

## Understand the execution differences

These licenses preserve the CLI's tool loop, permission controls, MCP configuration, skills, and cold session resume. They share Claude's selected Cloud MCP connections. They do not reuse warm processes, preventing a stale provider environment from surviving a credential or license change.

Qwen credentials never fall back to the operator's Anthropic login. The Qwen licenses are outside automatic failover between Claude Code and Codex in both directions. A turn moves to or from a Qwen license only when the conversation's selection names it together with other Claude Code licenses, through **Any license** or **If it fails, also use**. Otherwise, errors require repairing that provider's configuration or deliberately choosing another license.

## Check the limits

Usage records retain token counts without an invented dollar amount; the CLI's Anthropic-priced cost is discarded. Provider keys currently reach the harness as raw credentials rather than proxy placeholders. Proxy mode rejects private-address provider endpoints, including self-hosted endpoints on private networks. With several licenses selected, a Qwen license is skipped for a picked model that its catalog does not contain.

See [engine licenses](/docs/features/engine-licenses), [engine capabilities](/docs/engines), [engine authentication](/docs/configuration/engine-authentication), and [network policy](/docs/configuration/network-policy).
