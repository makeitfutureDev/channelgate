---
title: Automatic engine failover
description: Keep eligible requests moving when a license or a whole harness cannot answer.
---

When a turn cannot be answered, ChannelGate tries in two stages. First it moves to the selection's other [licenses](/docs/features/engine-licenses) of the same harness. Then, for a default selection, it can try the other harness: Claude Code to Codex and Codex to Claude Code. The reply announces each switch and its reason.

## Follow the order

1. **Other licenses of the same harness.** A selection made with **Any license**, or with an **If it fails, also use** list, names more than one license. The turn moves through them in order. This is automatic in both failover modes and also applies to a pinned thread, which stays on its harness. The picked model and effort are kept, and a license that cannot serve the picked model is skipped. A conversation with one selected license has no such step.
2. **The other harness.** After every license of the selection has failed, the gateway's failover setting decides whether the turn moves to the other harness. That harness's own sign-in must be switched on and admitted by the channel's **Approved harnesses** lock.

## Configure the fallback decision

An administrator controls failover between harnesses in gateway settings. It is on by default. **How a failover happens** offers two modes:

- **Auto**, the default, switches an eligible request automatically and announces the change.
- **Ask** presents a Slack card so the message's author can switch harnesses or retry the original one. The card appears only after every license of the selection has failed.

An accepted switch reruns the original message with its attachments and thread context. In Ask mode, choosing the alternative also pins that thread to the selected harness. Scheduled, background, continuation, and API runs cannot wait for a watched Slack card and use automatic behavior.

The setting and the mode govern the move to the other harness only. Moving between the licenses of one selection needs no setting.

## Recognize an eligible failure

Usage or plan limits, missing authentication, and supported temporary provider failures can trigger fallback. Temporary failures first receive the harness's in-place retries. The gateway uses cooldowns to avoid repeatedly hitting an unavailable license; a license known to be at its limit is tried last.

Automatic replay is constrained: a thrown failure is eligible only when no tool call and no streamed output were observed. A task that already changed files or sent a message must not be blindly executed twice. If every candidate fails, the answer preserves actionable error information and names the licenses that were tried rather than looping indefinitely.

## Keep deliberate choices

A thread explicitly pinned through `/model`, a `claude`/`codex` directive, or an explicit API harness/model override is not switched to the other harness. Its own licenses still apply: a pin or an API call that selects several licenses moves between them. Channel and gateway defaults are eligible defaults, not explicit pins.

For example, if you need Codex specifically, start with:

```text
@ChannelGate codex Review this patch using the selected Codex model.
```

If that harness fails on every selected license, repair it or deliberately choose another one. A successful default fallback becomes the thread's live session for subsequent replies.

The move to the other harness starts from a harness's own sign-in or from a license an administrator added, and it lands on the other harness's own sign-in. The other built-in licenses, including Codex EU, Claude Extra, the Qwen providers, and a conversation's own Codex login, are outside it in both directions.

Related: [engine licenses](/docs/features/engine-licenses), [models and effort](/docs/features/models-and-effort), [engine authentication](/docs/configuration/engine-authentication), and [gateway settings](/docs/configuration/gateway-settings).
