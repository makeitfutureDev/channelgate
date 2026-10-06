---
title: Conversation administration
description: Manage conversation details, inherited defaults, runtime choices, and bulk resets.
---

Open **Conversations** to manage channels, direct messages, and groups across registered platforms. Each conversation has a durable identity, workspace, access policy, and runtime configuration.

## Open a conversation

Use the conversation type and platform/source filters to find the right row. Detail URLs preserve the selected conversation so you can return directly to its settings. The displayed name is distinct from the platform's conversation ID and filesystem slug.

The detail tabs expose access, runtime/engine choices, connectors, skills, environment variables, workspace/Drive configuration, instructions, and memory where applicable. See [channel settings](/docs/configuration/channel-settings) for field-by-field setup.

## Inherit or override

A blank inherited model or engine follows gateway defaults; an explicit choice stays with that conversation. Existing thread pins can override the conversation runtime. Changing a gateway default therefore need not change a thread already pinned to another engine.

The admin bulk runtime reset can clear conversation overrides and optionally existing thread overrides. Choose that scope deliberately: clearing a pin does not change the engine that owns an existing live session. The separate access reset re-applies the organization access policy; it leaves skills, connectors, and tokens alone.

## Save safely

Only administrators use this web page. Chat managers have a narrower set of conversation controls. Folder changes must resolve to existing directories inside the operator's allowed filesystem root. Saved instructions use a version check: if another editor or agent changed the file, reload and reconcile the edit.

For example, to standardize inherited runtime choices across a team, update gateway defaults, reset conversation runtime overrides, and include thread pins only if the intended change covers existing threads.

Resetting runtime or access is not deleting the workspace or erasing memory.

## Related guides

- [Access templates](/docs/features/access-templates)
- [Settings search and conflicts](/docs/features/settings-search-and-conflicts)
- [Conversation controls](/docs/controls/conversation-settings)
