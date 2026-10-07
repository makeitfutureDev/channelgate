---
title: Finding and inspecting skills
description: Search the governed catalog and inspect a package before granting it.
---

A skill packages a repeatable workflow. Discovering it does not activate it, connect an account, or authorize its actions.

## Find the right workflow

Ask the agent to search by name, category, tags, description, or source:

```text
Find catalog skills for preparing a weekly project report. Show their descriptions and dependencies before adding anything.
```

`list_skills` returns up to 60 matches by default, sorted by recent usage and then slug. Administrators can see the whole catalog. Ordinary members see discoverable skills and skills already active in their context; ordinary members see personal packages only when they own them.

In **Admin → Skills**, filter by owner, source, category, enabled status, discoverability, mandatory status, or assignment. Select a package to inspect its files and revision history.

## Inspect before activating

Use `get_skill_info` for ownership, version, dependencies, files, effective revision, pinning, and publication state. Use `get_skill_file` to read `SKILL.md` or a named reference from the effective revision. The chat reader describes binary files instead of returning their bytes.

A staged package has no active revision until approved. A removed or excluded package cannot be activated normally. Compatibility notes identify engine, platform, gateway-version, and required-MCP constraints; a catalog entry is not a promise that every engine can run every component.

## Check what actually loads

Ask “Which skills are active here?” to call `show_channel_skills`. It distinguishes organization grants, the conversation's own grants, its template, channel-section skills, your personal grants, and dependencies. It also reports missing or staged items and estimated context cost.

Lean suppresses optional skills. Related: [grants](/docs/features/skill-grants), [governance](/docs/features/skill-governance), and [skill controls](/docs/controls/skills).
