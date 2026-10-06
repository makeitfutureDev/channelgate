---
title: Agent teams and in-turn delegation
description: Split a substantial task into bounded agent scopes and collect their results within the turn.
---

An agent can delegate part of an active task to other agents supported by its selected engine. This helps with independent research, parallel implementation, or a fresh review. The parent remains responsible for reconciling the results.

## Ask for a team

```text
@ChannelGate Split this review into API behavior, permissions, and documentation.
Give each agent a bounded scope, then reconcile their findings before answering.
```

Useful boundaries include different files, subsystems, evidence sets, or reviewer roles. State the deliverable for each agent and keep shared-file edits coordinated. Child agents work under the active runtime and permissions; delegation does not create additional authority.

The live progress surface can show agent activity separately from the parent. For substantial work, ask the parent to report the roster, the actual inherited or explicitly selected model and effort, completed batches, and unresolved disagreements. An unspecified model setting should remain unspecified rather than being guessed.

## Collect results before finishing

In-turn agents are owned by the engine session. Their work must be joined and incorporated before the parent gives its final report. ChannelGate installs a Claude Stop hook that blocks premature completion while model-owned background subagents or workflows remain active, with a bounded safety valve. Codex has its own agent orchestration lifecycle.

An engine's background flag does not make an agent a durable gateway job. Closing the parent turn can end that engine process and its children.

## Delegate work beyond the turn

For a task that should continue after the current reply, ask for a [background agent](/docs/features/background-jobs). The gateway daemon starts a separate fresh session from a self-contained brief and posts its report into the originating thread. The launching agent should end its turn instead of polling.

| Need | Choose |
| --- | --- |
| Parallel help that the parent will collect now | In-turn subagents |
| Work that should finish after the parent replies | Daemon-owned background agent |
| Long shell command with automatic continuation | Daemon-owned background shell job |

The last two use [agent interaction controls](/docs/controls/agent-interaction); they have distinct permission and approval rules.
