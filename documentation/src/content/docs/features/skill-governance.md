---
title: Skill governance and scope
description: Control enabled, discoverable, mandatory, and channel-specific packages.
---

Administrators govern which packages are available and how widely they load. Members can manage their own workflows without gaining organization-wide administration.

## Read the three catalog flags

| Flag | Meaning |
| --- | --- |
| Enabled | Package can participate in the active catalog |
| Discoverable | Ordinary members can find it before receiving a grant |
| Mandatory | Organization grant loads it in every conversation |

A mandatory package is enabled and discoverable. Disabling a package removes its organization grant and excludes it. A mandatory package cannot be made undiscoverable while remaining mandatory. These controls are in **Admin → Skills** and exposed to administrators through `set_skill_governance`.

Discoverability is separate from assignment: finding a skill does not activate it. An undiscoverable package already active in a member's context can still be inspected there. Personal visibility remains private to its author.

## Choose the right section

A channel section holds project-specific packages and activates them in that channel. The shared library makes a package available for other conversations to discover and grant; library membership alone does not necessarily make it mandatory.

Administrators use the skill detail **Section → Move** control or `set_skill_scope`. Moving a channel skill to the library preserves an explicit grant in the channel it leaves. Moving to a channel requires a real non-DM conversation and can move the published repository files too.

```text
Move the generic project-report skill into the shared library. Keep it active here, but do not grant it organization-wide.
```

Members request promotion with a proposal instead of moving shared scope directly.

## Exclude and restore

`set_skill_excluded` disables a synced or bundled package persistently across imports. Removing a source tombstones its packages. Restoring a package, following a source revision, granting a skill, and making it mandatory are distinct operations; inspect the resulting effective profile after changes.

Related: [grants](/docs/features/skill-grants), [reviews](/docs/features/skill-reviews), and [governance controls](/docs/controls/skills#set_skill_governance).
