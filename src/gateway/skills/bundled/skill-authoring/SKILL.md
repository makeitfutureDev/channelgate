---
name: skill-authoring
description: >-
  Create a new reusable skill, update one you authored, or propose a change to a shared skill
  from this conversation using the gateway's skill tools. Use when someone asks to "save this as
  a skill", "turn this procedure into a skill", "add a skill to the library", "improve the X
  skill", or when a task has become a repeatable procedure worth keeping for every channel.
category: Skills
version: 1.0.1
tags:
  - skills
  - authoring
---

# Authoring skills for the shared library

Skills are folders with a `SKILL.md` (YAML frontmatter + Markdown body) plus optional
`references/`, `scripts/` and `assets/` files. The gateway keeps them in its local catalog and
materializes them into every conversation that is granted them — Claude and Codex both discover
them natively by their frontmatter `name` and `description`.

## The SKILL.md contract

```markdown
---
name: customer-record            # short, unique, what the model calls it
description: >-                  # WHEN to use it — this text is always in context, keep it sharp
  Load, create or update a Makeitfuture customer record. Use whenever a task names a customer,
  deal or account by name and needs its ids, owners or history.
category: Sales                  # used by channel templates (Development, Sales, Marketing, …)
version: 1.0.0
tags: [crm, hubspot]
requires: [makeitfuture-organization]   # other catalog skills this one loads (auto-granted with it)
allowed-tools: Read Grep         # optional: tools the skill needs
---

# Customer record

Step-by-step instructions. Keep the body focused; put long material in `references/*.md` and
point to it ("read `references/ids.md` for the field map").
```

Rules for a description that actually fires:
- Say the **trigger** ("Use when …", "Use whenever a request mentions …"), not just the topic.
- Name the concrete nouns people use (product names, file types, verbs).
- One or two sentences; the body carries the detail.

## Tools

- `list_skills` / `get_skill_file` — see what already exists before writing a duplicate. Read a
  skill's `SKILL.md` and references with `get_skill_file`.
- `create_skill` — add a new skill to the library with its files; it is granted to this channel
  immediately (managers or admins can grant it elsewhere or add it to a template).
- `update_skill` — new revision of a skill you created (or any local skill, for managers/admins).
- `propose_skill_change` — for a shared skill you may not edit directly (synced from a
  repository, bundled, or authored by someone else): send the changed files plus a note; an admin
  reviews and approves it into a new revision.
- `show_channel_skills` — what is active here, what it costs in context, and what is missing.

## Workflow

1. Check for an existing skill (`list_skills` with a query). Prefer improving one over cloning it.
2. Draft `SKILL.md` first; test the trigger by asking yourself which requests should load it.
3. For `create_skill`, pass every file in the initial package, including `SKILL.md`.
   For `update_skill`, pass only changed or new files; files you omit are retained. To delete
   a file, name it explicitly in `remove` — omission is not deletion. For example, updating only
   `SKILL.md` keeps an existing `references/ids.md` unchanged.
   For a `propose_skill_change` of kind `change`, pass the changed or new files plus a note;
   approval merges them with the existing package. The proposal tool has no file-removal argument.
   Each resulting revision stores the complete folder; partial input does not replace prior
   revisions or discard unspecified files.
4. Tell the user what was created and where it applies. If a proposal was filed, say that an
   admin has to approve it before it becomes active.

Never put secrets, tokens, or personal data in a skill. Scripts run with the channel's normal
permissions only.
