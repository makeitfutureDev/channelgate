---
title: Context and compaction
description: Inspect context usage, compact an eligible Claude session, or deliberately start fresh.
---

Context is the information the selected engine can use in the current session. It includes prior messages and tool results plus the instructions and permitted runtime context supplied for this turn. Persistent memory and project files are separate sources that can be retrieved when needed.

## Inspect context usage

Send `/context` in an active Slack thread:

```text
@ChannelGate /context
```

The gateway reports an approximate token count from the last recorded turn, the resolved context window, and model attribution when available. Before a recorded turn exists, it reports that there is no activity yet. The answer footer can also show the previous turn's input-context percentage.

This is a usage snapshot, not a complete list of everything the model currently remembers. Different models have different context windows; changing the model can change the denominator.

## Compact a Claude session

For a Claude thread, use:

```text
@ChannelGate /compact Preserve the migration decisions and outstanding checks.
```

The command goes to the engine's native compaction behavior. Compaction can summarize accumulated history to reduce context pressure. It does not delete workspace files or replace durable channel memory. Keep essential project decisions in files or [memory](/docs/features/memory) so a later independent thread can find them.

The explicit `/compact` control is unsupported for Codex and the OpenCode proof adapter. Their own session behavior should not be confused with the gateway's Claude command.

## Start fresh or reduce injected context

`/clear` stops work in the thread and drops its session so the next request begins fresh. It also clears associated pending questions and native loops; project files and persistent memory remain.

For an intentionally bare task, use [Lean and thread Clean](/docs/features/lean-context). Toggling thread Clean changes the context boundary and resets the incompatible existing session. For an alternative that should retain eligible history, use [a conversation fork](/docs/features/conversation-forks).
