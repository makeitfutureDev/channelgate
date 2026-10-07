---
title: Automatic engine failover
description: Keep eligible default-engine requests moving when Claude or Codex is unavailable.
---

When a default engine cannot answer, ChannelGate can try the other enabled main engine. The route works in both directions: Claude to Codex and Codex to Claude. The reply announces the switch and its reason.

## Configure the fallback decision

An administrator controls failover in gateway settings. It is on by default. **How a failover happens** offers two modes:

- **Auto**, the default, switches an eligible request automatically and announces the change.
- **Ask** presents a Slack card so the message's author can switch engines or retry the original one.

An accepted switch reruns the original message with its attachments and thread context. In Ask mode, choosing the alternative also pins that thread to the selected engine. Scheduled, background, continuation, and API runs cannot wait for a watched Slack card and use automatic behavior.

## Recognize an eligible failure

Usage or plan limits, missing authentication, and supported temporary provider failures can trigger fallback. Temporary failures first receive the engine's in-place retries. The gateway uses cooldowns to avoid repeatedly hitting an unavailable engine.

Automatic replay is constrained: a thrown failure is eligible only when no tool call and no streamed output were observed. A task that already changed files or sent a message must not be blindly executed twice. If both engines fail, the answer preserves actionable error information rather than looping indefinitely.

## Keep deliberate choices

A thread explicitly pinned through `/model`, a `claude`/`codex` directive, or an explicit API engine/model override is not switched automatically. Channel and gateway defaults are eligible defaults, not explicit pins.

For example, if you need Codex specifically, start with:

```text
@ChannelGate codex Review this patch using the selected Codex model.
```

If that engine fails, repair it or deliberately choose another one. A successful default-engine fallback becomes the thread's live engine session for subsequent replies. Qwen providers and the OpenCode proof adapter are outside this fallback graph.

Related: [models and effort](/docs/features/models-and-effort), [engine authentication](/docs/configuration/engine-authentication), and [gateway settings](/docs/configuration/gateway-settings).
