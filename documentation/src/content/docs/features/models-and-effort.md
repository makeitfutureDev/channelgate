---
title: Models and reasoning effort
description: Choose the right engine, model, and effort for a thread or conversation.
---

Engine, model, and reasoning effort are separate selections. The engine determines which CLI runs and which capabilities are available. The model selects the provider model. Effort controls reasoning where that engine and model support it.

## Choose the scope first

Use `/model` in Slack. The wizard asks whether the change applies to **This channel** or **Just this thread**, then offers enabled engines and their models. **Settings → General** shows the channel defaults and the current thread pins together.

For a single demanding review, choose a thread model and supported higher effort without changing every future request in the channel. For routine project work, set a channel default. An administrator sets deployment-wide defaults in gateway settings. Organization policy can restrict channel runtime changes; a dedicated channel Codex login also fixes the engine choice to Codex.

```text
@ChannelGate Review this migration for data-loss risks before we implement it.
```

Choose the intended model before sending that request. A request to “think harder” in prose is not the same as saving a supported effort selection.

## Understand inheritance

Explicit run overrides take precedence, followed by thread selections, channel defaults, and gateway defaults. Existing threads can retain the engine that created their session when only a default changes. In the Slack settings view, **Follow channel default** clears the thread's engine, model, and effort pins.

Changing the engine clears a model that no longer belongs to it. The picker offers engine-appropriate effort values. If no model is configured, the harness uses its supported default behavior; the selected catalog and settings are the reliable place to inspect it.

## Recognize limits

Codex uses an available model catalog, Claude supports its configured model entries and rolling aliases, and opt-in Qwen providers discover their own catalogs. Availability can differ between accounts. A stored unavailable choice is not silently treated as an inheritance setting.

Explicit thread engine/model pins prevent automatic cross-engine failover. Related: [model defaults](/docs/configuration/model-defaults), [failover](/docs/features/multi-engine-failover), and [engine capabilities](/docs/engines).
