---
title: Engines, models, and effort defaults
description: Set gateway defaults, conversation overrides, and thread-specific runtime selections.
---

ChannelGate selects an engine first, then a model and supported effort setting for that engine. Organization defaults help make new conversations predictable, while a conversation or thread can deliberately choose a different runtime.

## Configure gateway defaults

Open **Settings → Agent defaults → Engine & runtime**.

| Control | What it does |
| --- | --- |
| Harnesses the gateway may use | Enables engines; disabled engines disappear from selectors and failover targets |
| Engine (which CLI drives the bot) | Default engine; Claude is the fallback default when none is configured |
| Default Claude model | Sets the model used by inherited Claude runs |
| Default Codex model | Sets the model used by inherited Codex runs |
| Default Claude / Codex effort | Sets reasoning effort when a conversation or thread does not override it |
| Provider default model and effort | Independent defaults on each optional Qwen provider card |
| Automatic failover between harnesses | Enables supported Claude–Codex recovery before work starts; defaults on |
| How a failover happens | Automatic, or ask in a live Slack thread; automatic is the default |

Optional provider harnesses must be explicitly enabled and authenticated. At least one engine must remain enabled. A model listed for one engine is not interchangeable with another engine's model.

1. Authenticate the engines you intend to use.
2. Disable engines the deployment cannot support.
3. Choose the default engine, model, and supported effort for each enabled engine when its controls offer them.
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

Set a conversation's **Engine**, **Model**, and **Effort** under **Conversations → Runtime**. On Slack, use `/model` to select a channel-wide or **just this thread** runtime. A thread-scoped choice does not change the default for other threads.

For a new run, explicit per-run overrides take precedence, followed by thread selection, conversation/DM selection, and gateway defaults. Existing threads retain their owning engine session unless explicitly switched or recovered; changing the global default does not automatically migrate every active thread.

Effort is engine- and model-dependent. Use the offered choices rather than assuming all models support `xhigh` or the same reasoning settings. An empty conversation or thread effort inherits the gateway's default effort for that harness. An empty gateway effort uses the CLI default; it is not proof of a specific reasoning level. Failover uses the destination harness's own gateway effort, checked against its selected model.

## Control who changes runtime

**Settings → Access & security → Runtime changes** offers **Org admins only** (default) or **All authorized users**. It covers both channel-wide and thread-only changes. Approved users can customize their own DM runtime separately.

**Reset all channels to these gateway defaults** clears overrides, with an option to clear thread pins too. Save the gateway defaults first. This bulk reset cannot be undone and does not replace existing threads' engine session ownership.

Saved runtime choices apply to subsequent turns; no daemon restart is normally needed. See [Models and effort](/docs/features/models-and-effort), [Threads and sessions](/docs/features/threads-and-sessions), and [Multi-engine failover](/docs/features/multi-engine-failover).
