---
title: Reusable skills
description: Give recurring workflows their own instructions, references, and scripts.
---

A skill is a reusable workflow package with a `SKILL.md` entry point and optional references, scripts, and assets. It tells the agent when to use the workflow and how to perform it. Skills do not grant tool permissions or connect provider accounts.

## Add the right skills

Open **Settings → Skills** in Slack or the conversation's **Skills** page in the admin UI. Choose individual catalog skills or follow a skill template. Templates are maintained centrally and followed live: changing a template updates the conversations that use it while preserving their own additional grants.

You can also ask the agent:

```text
@ChannelGate Add our customer-handover skill to this channel.
```

The effective set combines organization, conversation, and the requesting person's personal grants, plus required dependencies. The interface labels inherited grants so you can change them at the correct source. Removing a channel grant does not delete the catalog item or revoke it everywhere else.

## Create a project workflow

Ask for a skill when the procedure should be repeated:

```text
@ChannelGate Create a skill for preparing our weekly customer status report.
```

A skill created from a channel defaults to that channel's scope; one created in a DM defaults to personal scope. Authorized channel members can manage their channel workflows. Organization skills and global governance are moderated by administrators; a non-admin organization change becomes a proposal.

## Keep context and ownership clear

Organization and channel skills are synchronized into the project. Personal grants are private to the requesting author and do not become shared project skills. Both Claude and Codex can use granted skills, but their native command and plugin capabilities differ.

Catalog revisions preserve the exact package files and support history and rollback. External source ownership can require a proposal or companion skill instead of an in-place edit. Heavy profiles receive a warning above the default 6,000-token soft context threshold; this is a warning, not a permission or storage limit.

Lean removes optional skill grants. Related: [skill sources](/docs/configuration/skill-sources), [plugins](/docs/features/plugins), and the [complete skills reference](/docs/skills).

## Explore the skills handbook

- [Discovery and inspection](/docs/features/skill-discovery)
- [Grants and dependencies](/docs/features/skill-grants)
- [Templates](/docs/features/skill-templates)
- [Authoring](/docs/features/skill-authoring)
- [Reviews, history, and rollback](/docs/features/skill-reviews)
- [Governance and scope](/docs/features/skill-governance)
- [Sources and synchronization](/docs/features/skill-synchronization)
- [Git publishing](/docs/features/skill-publishing)
- [Usage and context cost](/docs/features/skill-usage)
- [External skills library](/docs/features/skills-library-mcp)
- [All thirty skill controls](/docs/controls/skills)
