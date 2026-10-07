---
title: Access templates
description: Set starting modes, network policy, models, and tools for new conversations and direct messages.
---

Access templates provide a repeatable starting configuration. An administrator can establish how a newly registered conversation begins, while keeping each conversation's later settings distinct.

## Configure a starting policy

Open **Settings → Access templates** in your instance's admin interface. Review the new-channel template and the separate direct-message templates for users and administrators.

A template can include the mode's underlying flags, Auto, Lean, network access, selected MCP tools, skills, and engine/model defaults. These selections do not approve a person or bypass conversation membership and access checks.

## Channels and direct messages differ

| Template | Application behavior |
| --- | --- |
| New channel | Copied when a non-DM conversation is first registered. Later template edits do not rewrite existing channels. |
| User DM | Used as the live selection for DMs following the user template. |
| Admin DM | Used as the live selection for DMs following the administrator template. |

A direct message with custom overrides follows its custom configuration instead of automatically inheriting every later template change.

## Review the defaults

The code's initial new-channel template enables Worker tools, Auto, and network access. Initial DM templates are read-only with Auto and network disabled. The operator can change these defaults before onboarding a team; inspect your deployment's actual template rather than assuming every new workspace starts read-only.

For a controlled rollout, an administrator can deliberately choose Worker, leave Auto off until the task policy is agreed, and grant only the tools and connections needed for the first workflow.

## Access templates and skill templates

A skill template is a reusable set of skills. An access template is a starting conversation policy that can select a skill template alongside its other settings. Assigning skills does not grant arbitrary external accounts or expand the runtime's mounts.

After changing a new-channel template, test it with a new disposable conversation. Inspect an existing conversation separately to verify that its established policy stayed intact.

## Related guides

- [Users and access](/docs/configuration/access-and-users)
- [Channel settings](/docs/configuration/channel-settings)
- [Skills and sources](/docs/configuration/skill-sources)
