---
title: Skill usage and context cost
description: See which workflows are used and keep the active profile focused.
---

The catalog records skill use so a team can distinguish a useful grant from instructions that load repeatedly without helping. Usage is evidence of recorded activity, not a billing estimate for a whole task.

## Inspect this conversation

```text
Show skill usage for this channel over the last 30 days. Identify granted skills with no recorded use and explain any inferred records.
```

`skill_usage_report` defaults to 30 days and accepts 1–365 days. It returns one total per skill, the exact time window, recorded user/conversation attribution, inferred-read provenance, and shared grants never used in that range. Missing historical identities remain unknown rather than being guessed.

## Explore the administrator view

**Admin → Skills → Usage** supports skill and conversation views and filters for the available record dimensions. The catalog's main table shows **Usage 30d**, while a skill detail shows its longer recorded history. Use attribution and timestamps to understand what produced a count.

A package description is always present when granted; detailed files are read when the agent applies it. `show_channel_skills` estimates always-on context across the effective profile and flags overlapping triggers or missing dependencies.

## Tune the profile

The default context soft cap is **6,000 tokens**, configurable under **Skills → Sync settings → Catalog settings → Context soft cap**. It is a warning threshold, not a hard grant limit. Organization grants contribute to every conversation, so account for them when previewing a template.

Deactivate unused optional conversation skills, remove personal grants you no longer need, or refine overly broad trigger descriptions through the correct authoring path. A dependency cannot be removed while its parent still requires it. Mandatory organization packages require an administrator to change their grant.

Related: [grants](/docs/features/skill-grants), [discovery](/docs/features/skill-discovery), [usage and costs](/docs/features/usage-and-costs), and [usage control](/docs/controls/skills#skill_usage_report).
