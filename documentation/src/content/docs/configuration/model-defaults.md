---
title: Engines, models, and effort defaults
description: Set gateway defaults, conversation overrides, and thread-specific harness, license, model, and effort selections.
---

ChannelGate selects a harness first, Claude Code or Codex, then a [license](/docs/features/engine-licenses) of that harness, then a model and supported effort setting for that license. Organization defaults help make new conversations predictable, while a conversation or thread can deliberately choose a different runtime.

## Configure gateway defaults

Open **Settings → Agent defaults → Engine & runtime**. Licenses themselves are listed, added, edited, verified, removed, and switched on and off under **Settings → Engine licenses**; a switched-off license disappears from selectors and failover candidates, and a harness with no switched-on license is not offered. See [engine licenses](/docs/features/engine-licenses).

| Control | What it does |
| --- | --- |
| Harness | Default harness; Claude Code is the fallback default when none is configured |
| License | Shown when the default harness has more than one usable license: **Any license**, or one license with an optional **If it fails, also use** list |
| Default Claude model | Sets the model used by inherited Claude runs |
| Default Codex model | Sets the model used by inherited Codex runs |
| Default Claude / Codex effort | Sets reasoning effort when a conversation or thread does not override it |
| License default model and effort | Independent defaults for each further license, such as an optional Qwen provider card or a license an administrator added |
| Automatic failover between harnesses | Enables supported recovery between Claude Code and Codex before work starts; defaults on. Moving between the licenses of one selection does not depend on it |
| How a failover happens | Automatic, or ask in a live Slack thread; automatic is the default |

Optional built-in licenses must be explicitly switched on and authenticated; a license an administrator adds is switched on when it is added. At least one license must remain switched on. A model listed for one license is not interchangeable with another license's model.

1. Authenticate the licenses you intend to use, and add further ones as described in [engine licenses](/docs/features/engine-licenses).
2. Switch off licenses the deployment cannot support.
3. Choose the default harness and, when it is offered, the default license. Then choose the model and supported effort for each switched-on license when its controls offer them.
4. Save, then create a fresh thread to check inherited behavior.

An empty gateway model setting lets the CLI use its own default. An explicit gateway model helps avoid changes in the operator's interactive terminal model choice affecting gateway runs.

## Default model shortcuts

New installations include `:astra`, `:sol`, `:terra`, `:fable`, `:opus`, and `:sonet` (Sonnet).
Use `@agent :sonet your task` in Slack to select and pin the current supported Sonnet model.
Before an administrator saves a custom shortcut list, targets follow the newest stable version
of each family in the gateway's model catalog. Codex uses its authenticated CLI catalog, with a
bundled fallback; Claude uses the curated catalog in the installed gateway version. Updating the
CLI or gateway is therefore still necessary when a provider exposes a model they do not yet list.
Unavailable families are omitted rather than assigned a guessed model ID.

Edit shortcuts under **Settings → Access & security → Model shortcuts**. A saved list uses those
exact mappings until edited again; an empty list disables shortcuts. Existing customized lists and
thread pins survive updates. Saving unrelated settings does not turn inherited defaults into pins.

## Conversation and thread overrides

Set a conversation's **Harness**, **License**, **Model**, and **Effort** under **Conversations → Runtime**. On Slack, use `/model` to select a channel-wide or **just this thread** runtime. A thread-scoped choice does not change the default for other threads.

Every level uses the same steps: harness, then license, then model, then effort. The **License** control offers **Any license** or one license; **If it fails, also use** adds more licenses of the same harness, and the turn moves to the next one when a license cannot answer. The control is not shown when the harness has a single usable license in that conversation. A run API call selects the same way with its `harness` and `licenses` fields.

For a new run, explicit per-run overrides take precedence, followed by thread selection, conversation/DM selection, and gateway defaults. Existing threads retain their owning session unless explicitly switched or recovered; changing the global default does not automatically migrate every active thread. When a selected license is removed, the conversation or thread that selected it falls back to the next level's default.

Effort is license- and model-dependent. Use the offered choices rather than assuming all models support `xhigh` or the same reasoning settings. An empty conversation or thread effort inherits the gateway's default effort for that harness. An empty gateway effort uses the CLI default; it is not proof of a specific reasoning level. A move to another license of the same harness keeps a picked model and effort. Failover to the other harness uses the destination harness's own gateway effort, checked against its selected model.

## Control who changes runtime

**Settings → Access & security → Runtime changes** offers **Org admins only** (default) or **All authorized users**. It covers both channel-wide and thread-only changes. Approved users can customize their own DM runtime separately.

**Reset all channels to these gateway defaults** clears overrides, with an option to clear thread pins too. Save the gateway defaults first. This bulk reset cannot be undone and does not replace existing threads' session ownership.

Saved runtime choices apply to subsequent turns; no daemon restart is normally needed. See [Engine licenses](/docs/features/engine-licenses), [Models and effort](/docs/features/models-and-effort), [Threads and sessions](/docs/features/threads-and-sessions), and [Multi-engine failover](/docs/features/multi-engine-failover).
