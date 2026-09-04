# Skills: what is active here, templates, authoring and proposals

Skills are reusable procedures (a `SKILL.md` plus references/scripts) that the gateway keeps in
its own local **catalog** and materializes into this conversation's folder as real files. You
discover them natively — the always-on list is each skill's name + description; the body loads
when a skill fires. No token or network call is involved.

## Seeing what is active

- `show_channel_skills` — the skills granted here (organization tier + this channel + the
  requester's personal grants), dependencies that were pulled in automatically, anything
  missing or awaiting review, and the estimated always-on context cost.
- `list_skills` (optional `query`, `category`) — everything in the catalog, with owner
  (bundled / local / folder / git source), version and category.
- `get_skill_file` — read a catalog skill's `SKILL.md` or one of its files without granting it.
- `skill_usage_report` (optional `days`) — which skills fired here and which granted ones never
  did. Claude's Skill tool gives exact counts; Codex reads the file, so those counts are
  labelled *inferred*.

## Changing this channel's skills (managers, or an admin)

- `add_channel_skills` / `remove_channel_skills` — grant or revoke skills here by slug.
  Dependencies (`requires:` in a skill's frontmatter) are added with the skill. Active on the
  next message.
- `list_skill_templates` / `preview_skill_template` / `apply_skill_template` — templates such as
  **Development**, **Sales**, **Marketing**, **Management** are named skill sets (explicit skills
  and/or categories). Preview shows what would be added or removed; apply copies a snapshot into
  this channel's grants (`mode: "add"` keeps the current grants, `"replace"` makes the list
  exactly the template's). A later template edit never changes this channel by itself.

These change persistent state, so they show an Approve/Deny card in the conversation unless the
channel is in auto mode.

## Authoring (anyone approved to use the channel)

- `create_skill` — add a new skill to the shared catalog from files you pass (`SKILL.md`
  required) and grant it to this channel at once. Use the `skill-authoring` skill for the
  frontmatter contract and a description that actually triggers.
- `update_skill` — a new revision of a skill you created (managers and admins may update any
  locally authored skill). Pass the changed files; unnamed files are kept.
- `propose_skill_change` — for a skill you may not edit directly (synced from a repository,
  bundled, or someone else's): send the changed files and a note. An admin reviews it; on
  approval it becomes a new revision (pinned as a local override when the skill comes from a
  source). `kind: "promote"` asks for a skill to be granted organization-wide.

## Admins

- `list_skill_proposals` / `decide_skill_proposal` — review pending proposals in the thread
  (`decision: "approve" | "reject"`, optional `note`).
- `sync_skill_sources` — pull the configured GitHub sources now (a source in *review* mode
  stages new revisions for approval in the admin UI; *auto* activates them).
- Sources, templates, pins/rollbacks, staged revisions and the usage dashboard live in the admin
  UI under **Skills**.
