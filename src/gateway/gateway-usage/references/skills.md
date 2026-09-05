# Skills: what is active here, templates, authoring and proposals

Skills are reusable procedures (a `SKILL.md` plus references/scripts) that the gateway keeps in
its own local **catalog** and materializes into this conversation's folder as real files. You
discover them natively — the always-on list is each skill's name + description; the body loads
when a skill fires. No token or network call is involved.

## Seeing what is active

- `show_channel_skills` — the skills granted here (organization tier + this channel + the
  requester's personal grants), dependencies that were pulled in automatically, anything
  missing or awaiting review, and the estimated always-on context cost.
- `list_skills` (optional `query`, `category`, `source`) — search discoverable skills by slug,
  name, description, tags, category and source. Admins see all; an ordinary member also sees
  non-discoverable skills already active in this conversation.
- `get_skill_file` — read a catalog skill's `SKILL.md` or one of its files without granting it.
- `skill_usage_report` (optional `days`) — which skills fired here and which granted ones never
  did. Claude's Skill tool gives exact counts; Codex reads the file, so those counts are
  labelled *inferred*.

## Your own skills (any approved member)

- `add_my_skills` / `remove_my_skills` — carry catalog skills in YOUR runs, in every
  conversation (the personal tier; like starring in a skill library). No approval card.
- `get_skill_info` — a skill's owner, version, revisions, files and dependencies.

## Changing this channel's skills (managers, or an admin)

- `add_channel_skills` / `remove_channel_skills` — grant or revoke skills here by slug.
  Dependencies (`requires:` in a skill's frontmatter) are added with the skill. Active on the
  next message.
- `list_skill_templates` / `preview_skill_template` / `set_channel_skill_template` — templates
  such as **Development**, **Sales**, **Marketing**, **Management** are named skill sets. A
  channel FOLLOWS its template live: it gets the template's current skills, and
  `add_channel_skills` adds on top; `template: "none"` stops following (the channel's own
  additions stay). Preview shows what the channel would gain, keep or drop.

These change persistent state, so they show an Approve/Deny card in the conversation unless the
channel is in auto mode.

## Authoring (anyone approved to use the channel)

- `create_skill` — add a new skill to the shared catalog from files you pass (`SKILL.md`
  required) and grant it to this channel at once; `personal: true` keeps it private to you. Use
  the `skill-authoring` skill for the frontmatter contract and a description that actually
  triggers. When Git publishing is configured the files are also pushed to the repository.
  **Where it lives:** the default is the shared library (every conversation can use it). Only
  when the skill is specific to this channel's customer or project — their data, their
  systems, their procedures — ask the user whether it should stay with this channel only, and
  then pass `scope: "channel"`: it goes to the channel's own section of the skills repository
  (`channels/<channel id>/`) and is granted here automatically. Name skills uniquely across
  the whole repository (prefix customer skills with the customer, e.g. `acme-invoice-check`).
- `update_skill` — a new revision of a skill you created (managers and admins may update any
  locally authored skill). Pass the changed files; unnamed files are kept.
- `propose_skill_change` — for a skill you may not edit directly (synced from a repository,
  bundled, or someone else's): send the changed files and a note (`kind: "change"`), a note
  alone (`kind: "feedback"`), or `kind: "promote"` (a personal skill becomes an organization
  skill; an organization skill gets granted everywhere). An admin reviews it; an approved change
  becomes a new revision (pinned as a local override when the skill comes from a source).
- `delete_skill` — remove a skill you authored (admins: any local skill); restorable by an admin.

## Admins

- `list_skill_proposals` / `decide_skill_proposal` — review pending proposals in the thread
  (`decision: "approve" | "reject"`, optional `note`).
- `sync_skill_sources` — pull the configured sources now (a source in *review* mode stages new
  revisions for approval in the admin UI; *auto* activates them).
- `list_skill_sources` / `add_skill_source` / `set_skill_source` / `remove_skill_source` — the
  sources: GitHub repositories, host folders, or a peer gateway (URL + a token minted there).
- `add_org_skills` / `remove_org_skills` — mandatory skills loaded in every conversation.
- `set_skill_governance` — enable/disable a catalog skill, approve it for organization-wide
  discovery, or make it mandatory. Mandatory implies enabled and discoverable.
- `set_skill_excluded` — hide a synced/bundled skill from the catalog (it stays hidden across syncs) or bring it back.
- `publish_skill` (managers too) — push a local skill to the configured Git repository now.
- `set_skill_scope` (managers) — move a skill between the shared library and a channel's section
  (`scope: "library"` promotes a customer skill for everyone; the channel it leaves keeps it as
  an explicit grant; `scope: "channel"` keeps it for one customer). The files move in the
  repository too.
- Templates, pins/rollbacks, staged revisions, access tokens for the catalog's MCP endpoint, the
  GitHub webhook and the usage dashboard live in the admin UI under **Skills**.
