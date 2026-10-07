---
title: Customizing the gateway operating guide
description: Keep common agent behavior consistent across every conversation.
---

The bundled `gateway-usage` skill is the agent's operating manual for ChannelGate. It explains supported chat output, tool identities, questions, files, approvals, memory, and administration. The gateway delivers the resolved guide to channel folders on subsequent requests.

## Inspect the effective guide

Ask the agent to list guide files and identify customized overrides, then read the relevant file. `get_gateway_guide` without a file returns the inventory; a file such as `references/sharing-files.md` returns its active content.

```text
Show the current gateway guide's file list, then read the sharing-files reference and say whether it is customized.
```

The shipped defaults remain in the repository. Administrators can overlay individual files without editing those defaults. Unmodified files continue following the bundled version when the gateway is updated.

## Customize one reference

An administrator supplies the complete new Markdown with `update_gateway_guide`. The default target is `SKILL.md`; a named `references/<name>.md` can update or introduce a reference. Changes propagate to every conversation on the next message.

Keep the guide general: how the agent should operate on supported chat surfaces. Customer facts belong in [memory](/docs/features/memory); local behavioral rules belong in [channel instructions](/docs/features/channel-instructions); specialized procedures belong in [skills](/docs/features/skill-authoring).

## Restore the baseline

`reset_gateway_guide` with a file removes that override. With no file it removes all guide customizations and restores the shipped baseline. Administrator changes follow the gateway's administration/approval policy.

Platform-specific overlays adjust the general guide to Slack, Teams, or Google Chat capabilities; unavailable platform functions are removed at materialization. A common rule cannot make an unsupported rich artifact render on a platform.

Related: [permissions](/docs/features/permissions), [chat platforms](/docs/platforms), and [channel instructions](/docs/features/channel-instructions).
