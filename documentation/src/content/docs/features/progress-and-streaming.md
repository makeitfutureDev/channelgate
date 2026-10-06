---
title: Live progress and streamed answers
description: Follow stages, tools, thinking activity, and agent work while an answer is being prepared.
---

ChannelGate makes active work visible in Slack. Depending on the engine's events, you can see a live progress card, tool activity, agent activity, and a separate streamed answer.

## Read the progress surface

When a turn emits task, tool, or thinking events before its answer, the gateway creates the progress card first and streams the answer into a later message. Expanding completed thinking or tool activity does not split an answer sentence. A simple text-only turn can retain a single-message shape.

The card represents the events the engine actually emitted. A quiet interval is not proof that the task has stopped. Activity updates and health handling distinguish continued processing from an engine that has exited or become unavailable.

## Ask for meaningful stages

```text
@ChannelGate Audit the import pipeline. Show progress for inventory,
reproduction, fixes, and verification, including how many cases are complete.
```

For substantial work with known stages, the agent can publish a **Plan** through `report_progress`. That plan is separate from the automatic trace of individual tool calls. Stages should describe outcomes, such as “Review permissions,” rather than internal operations such as “Read file.”

Each update replaces the authoritative snapshot. Stages use stable IDs, at most one is in progress, and failed stages can be marked as errors. Details, outputs, and source links can explain the evidence without filling the chat with raw logs.

## Find the final result

The final answer stays in the originating thread. Long answers may continue across several messages; statistics and the Files, Variables, and Settings menu accompany the last message. Generated workspace image references can become native file previews after the answer.

Streaming and native interactive cards are Slack-specific capabilities. Teams and Google Chat are Beta and use the presentation supported by their adapters.

Related: [steer, queue, and stop](/docs/features/collaboration-and-steering), [agent teams](/docs/features/subagents), [usage and costs](/docs/features/usage-and-costs), and the [`report_progress` reference](/docs/controls/agent-interaction#report_progress).
