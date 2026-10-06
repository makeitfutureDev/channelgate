---
title: Authentication health
description: Inspect the resolved engine login and receive bounded alerts when Claude authentication needs repair.
---

Engine health answers more than whether a CLI executable exists. ChannelGate checks the configured engine, resolved authentication, and runtime availability so operators can distinguish missing tools from expired login or provider failure.

## Inspect health

Use **Settings → System**, the runtime status in **Settings → Access & security**, or the chat `/status` command. An authenticated `/api/health` response includes registered engine health and enablement. See [engine authentication](/docs/configuration/engine-authentication) for supported login sources and precedence.

A container uses the gateway's configured credential relay; it does not inherit the operator's whole login store merely because the CLI is installed. The current turn's resolved authentication and mount facts are the useful evidence.

## Claude login alerts

An hourly watch checks the resolved Claude login. While it is missing or within the expiry warning window, it can DM administrators. Alerts are limited to once per **UTC day per message class**, with durable markers that survive restarts. A healthy login resets the alert class.

The first watch is delayed until after boot so the chat connection can establish. The alert contains the kind, expiry, location context, and remedy, never token material. Repair requires the operator's appropriate host-side login or configured credential; the next turn can pick up the repaired login without a daemon restart.

## Practical workflow

If a task unexpectedly switches engines, inspect the original engine's health before changing models. Restore the relevant account, confirm the next small turn, then check whether failover has returned according to the configured recovery policy.

## Limits

The proactive expiry watch described here is for Claude. Do not infer identical Codex expiry alerts. An enabled engine can still be temporarily unavailable, and a healthy local login does not prove a particular model is entitled to the account.

## Related guides

- [Multi-engine failover](/docs/features/multi-engine-failover)
- [Health endpoints](/docs/features/health-endpoints)
- [Engine authentication](/docs/configuration/engine-authentication)

A successful cross-engine failover can leave the existing thread on the engine that answered it. Repairing the original login does not automatically switch that thread back; use the model/engine control deliberately when you want to change it.
