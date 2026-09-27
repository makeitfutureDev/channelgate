---
name: skill-authoring
description: >-
  Create a new reusable skill, update one you authored, or propose a change to a shared skill
  from this conversation using the gateway's skill tools. Use when someone asks to "save this as
  a skill", "turn this procedure into a skill", "add a skill to the library", "improve the X
  skill", or when a task has become a repeatable procedure worth keeping.
category: Skills
version: 1.1.0
tags:
  - skills
  - authoring
---

# Authoring skills

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
- `create_skill` — add a new skill with its files. Omit `scope`: in a channel it becomes a
  **channel skill** (active here, any member may edit or deactivate it); in a DM, the
  requester's personal skill. Pass `scope: "organization"` only when the user explicitly asked
  for an organization-level skill (an admin's lands in the shared library at once; anyone else's
  starts as a channel skill with a promotion request for an admin).
- `update_skill` — new revision. Personal: its author; channel: any member of that channel;
  organization: an admin (a non-admin's edit is filed as a proposal automatically).
- A skill whose source this gateway cannot write to (bundled, another repository, a host folder,
  a peer gateway) is not edited in place: create a **companion skill** that lists the original
  under `requires:` and carries the extra references.
- `propose_skill_change` — ask an admin for an organization-level change: files plus a note, a
  promotion, or a catalog delete; an admin reviews it.
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
4. Personal and channel skills need no approval — when the user asked for the skill, create or
   update it without asking again. Then tell the conversation what was created or changed and
   where it applies. If a proposal was filed, say that an admin has to approve it before it
   becomes active.

Never put secrets, tokens, or personal data in a skill. Scripts run with the channel's normal
permissions only.
