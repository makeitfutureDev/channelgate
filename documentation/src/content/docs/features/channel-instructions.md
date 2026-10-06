---
title: Channel instructions
description: Set standing workspace context and working rules that apply to future agent sessions.
---

Channel instructions describe how work should happen in a conversation. They are useful for the workspace's purpose, writing conventions, expected deliverables, and recurring constraints. New engine sessions receive these instructions alongside the gateway's managed operating rules.

## Write useful instructions

Keep a rule specific enough that the agent can apply it:

> This workspace maintains the documentation. Write in English, verify feature claims against source, and include a preview link with any website change.

Describe stable expectations. A task-specific deadline belongs in its thread; a remembered project fact belongs in [persistent memory](/docs/features/memory); a repeatable procedure belongs in a [skill](/docs/features/skills).

## Configure the conversation

1. Open the conversation in your instance's admin interface.
2. Select **Instructions** and review its current standing rules.
3. Add or revise the custom content and save using the available controls.
4. Start a new session when you need to verify that a revised rule is present from the beginning.

The gateway maintains its own managed block in the instruction file. Custom instructions coexist with that block; they do not replace authorization, mount decisions, or the tool policy.

## Request a change in chat

Ask the agent to add an exact rule, for example:

> Add this standing instruction: include a short summary and the verification result when completing a documentation change.

An agent-requested instruction update has a reviewable approval flow. The card holds the exact proposed text and destination. A pending change can be refused if the instructions or working folder changed before approval, so an old card does not silently replace newer work. Replacing all channel instructions requires administrator authority.

## Check the scope

Instructions are shared conversation context, not private notes for one member. Avoid personal credentials and sensitive account details. Read-only tools and disabled network access remain disabled even when an instruction asks the agent to use them.

## Related guides

- [Channel settings](/docs/configuration/channel-settings)
- [Approvals](/docs/features/approvals)
- [Persistent memory](/docs/features/memory)
