---
title: Failure diagnosis
description: Open a bounded source investigation for unexpected failures without automatically applying a fix.
---

ChannelGate can open a diagnosis thread when an interactive Slack run fails unexpectedly. The diagnosis receives the error, selected recent events, and a link back to the failed thread where available, then investigates the source and proposes a fix.

## Enable deliberately

The feature is **off by default**. An operator sets `errorDiagnosisChannel` in gateway settings or `ERROR_DIAGNOSIS_CHANNEL` in the daemon environment to a registered non-DM conversation slug. The settings value takes precedence when present.

Choose a development conversation whose work folder contains the gateway source. There is no dedicated diagnosis field in the current settings web form. The investigation runs as the failing turn's author under the target conversation's access, tokens, mode, and licensing rules.

## What it diagnoses

Crashes, stalls, malformed requests, denials, and unclassified failures can warrant source investigation. Known provider states—usage limits, authentication, billing, rejected models, availability, and connection problems—are skipped. A user-requested stop is also skipped.

The diagnosis asks for a root cause, source location, and proposed change. It explicitly instructs the agent not to apply a fix. This is an investigation workflow, not automatic remediation.

## Guardrails

There is a gateway-wide **30-minute cooldown**. A diagnosis failure does not diagnose itself. If no diagnosis thread can be posted, the workflow stops instead of creating an invisible session.

For example, a parser crash can generate a proposal in the selected development conversation; a quota error should lead to the provider's limit remedy in the original conversation.

## Scope

This automation uses the Slack failure path. Do not assume equal automatic diagnosis support on Beta platforms. Diagnosis consumes an engine turn and can fail independently; inspect its reported outcome.

## Related guides

- [Authentication health](/docs/features/authentication-health)
- [Activity and audit](/docs/features/activity-and-audit)
- [Multi-engine failover](/docs/features/multi-engine-failover)
