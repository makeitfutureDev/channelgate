---
title: Models and reasoning effort
description: Choose the right harness, license, model, and effort for a thread or conversation.
---

Harness, license, model, and reasoning effort are separate selections, made in that order. The harness, Claude Code or Codex, determines which CLI runs and which capabilities are available. The license is the credential and server the harness uses. The model selects the provider model. Effort controls reasoning where that license and model support it.

## Choose the scope first

Use `/model` in Slack. The wizard asks whether the change applies to **This channel** or **Just this thread**, then offers the harnesses that have a usable license, a **License** step, and the models of the selected license. **Settings → General** shows the channel defaults and the current thread pins together.

The **License** step offers **Any license** or one named license, and **If it fails, also use** adds more licenses of the same harness for the gateway to move to. The step is not shown when the harness has a single usable license in the conversation. [Engine licenses](/docs/features/engine-licenses) explains licenses and their failover order.

For a single demanding review, choose a thread model and supported higher effort without changing every future request in the channel. For routine project work, set a channel default. An administrator sets deployment-wide defaults in gateway settings. Organization policy can restrict channel runtime changes, and a channel's **Approved harnesses** lock limits the harnesses and licenses that are offered.

```text
@ChannelGate Review this migration for data-loss risks before we implement it.
```

Choose the intended model before sending that request. A request to “think harder” in prose is not the same as saving a supported effort selection.

## Understand inheritance

Explicit run overrides take precedence, followed by thread selections, channel defaults, and gateway defaults. Existing threads can retain the license that created their session when only a default changes. In the Slack settings view, **Follow channel default** clears the thread's harness, license, model, and effort pins.

Changing the harness or license clears a model that no longer belongs to it. The picker offers effort values appropriate to the selected license and model. If no model is configured, the harness uses its supported default behavior; the selected catalog and settings are the reliable place to inspect it.

## Recognize limits

Codex uses an available model catalog, Claude Code supports its configured model entries and rolling aliases, and provider licenses such as Qwen discover or list their own catalogs. Availability can differ between licenses. With several licenses selected, a license that cannot serve the picked model is skipped. A stored unavailable choice is not silently treated as an inheritance setting.

Explicit thread harness/model pins prevent automatic failover to the other harness; the thread's own licenses still apply. Related: [engine licenses](/docs/features/engine-licenses), [model defaults](/docs/configuration/model-defaults), [failover](/docs/features/multi-engine-failover), and [engine capabilities](/docs/engines).
