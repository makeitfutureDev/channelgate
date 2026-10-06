---
title: Persistent conversation memory
description: Keep decisions and project knowledge available across new threads.
---

Channel memory retains durable preferences, decisions, and project facts after an engine thread ends. It belongs to the conversation's working folder, separate from each thread's engine session.

## Save useful knowledge

Ask the agent to remember a fact with a clear scope:

```text
@ChannelGate Remember that this customer's production deployments happen on Tuesdays.
```

Future threads receive a compact catalog of available memory and retrieve relevant notes on demand. They do not automatically load the entire history. The portable source is Markdown: `MEMORY.md` for indexed facts and `memory/` for longer topic notes.

Use memory for things that remain useful, such as a deployment environment or a confirmed project decision. Put standing behavioral rules in conversation instructions or a skill. Credentials belong in the secret store; secret-shaped and instruction-shaped memory saves are refused.

## Review or correct a fact

Ask the agent to search the conversation's memory, replace an outdated fact, or remove a mistaken one. The admin UI also offers memory inspection for the conversation. Memory updates use dedicated gateway tools and can work in Read-only mode; enabling shell writes is not required just to save a project fact.

A post-reply reviewer can recover durable facts the answering agent missed. Its defaults are the `haiku` model, a review every five non-trivial turns, and a notification when it saves something. Corrections or decision-shaped messages can trigger an earlier review. The administrator can configure the model, cadence, and notifications; zero disables background memory review, including early reviews triggered by message signals.

## Enable or disable memory

Agent memory is on by default, with a per-conversation override. Inspect its effective setting before assuming a new thread will recall previous project facts. Turning it off is not a cross-system deletion procedure, and clearing a thread's session does not remove saved notes.

Memory retrieval is conversation-scoped; unrelated conversations do not automatically share it. A custom shared working folder deserves the same access review as shared project files.

Related: [threads and sessions](/docs/features/threads-and-sessions), [channel settings](/docs/configuration/channel-settings), and [skills](/docs/features/skills).
