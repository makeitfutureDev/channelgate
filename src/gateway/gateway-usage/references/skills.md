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

## Who owns what — and what needs nobody's approval

Three tiers, three owners:

- **Personal** — yours. Only your runs load it. You create, edit and delete it.
- **Channel** (a *project* skill) — lives in this channel's own section and is active here
  automatically. It belongs to the channel: **any member** creates, edits or deactivates it.
- **Organization** — the shared library every conversation can use. **Admins** moderate it.

Personal and channel changes never wait for anyone: no Approve card, no "are you sure?". When
the user asks you to create or update a skill, do it — don't ask again for confirmation, and
don't ask where it goes (the default below decides). After every create, update, deactivate or
delete, **say so in your reply** (name the skill and what changed) so the whole conversation
sees it; the tool result reminds you.

Only organization-level changes by a non-admin go to an admin, and the tools do that for you:
the request is filed as a proposal and the user is told. An admin's own organization change
applies at once.

## Your own grants (any approved member)

- `add_my_skills` / `remove_my_skills` — carry catalog skills in YOUR runs, in every
  conversation (the personal tier; like starring in a skill library). No approval card.
- `get_skill_info` — a skill's owner, version, revisions, files and dependencies.

## This channel's skills (any member)

- `add_channel_skills` / `remove_channel_skills` — activate or deactivate skills here by slug.
  Deactivating also works for a skill this channel's template or its own section brings in: it is
  turned off **for this conversation only** and stays in the catalog; `add_channel_skills` turns
  it back on. When a member says "delete this skill" about a channel skill, this is what they
  mean. Whatever a skill requires (`requires:` in its frontmatter) loads with it as a dependency,
  not as a grant of its own: it is listed as *required by* that skill and goes away with it.
  Active on the next message.
- `list_skill_templates` / `preview_skill_template` / `set_channel_skill_template` — templates
  such as **Development**, **Sales**, **Marketing**, **Management** are named skill sets. A
  channel FOLLOWS its template live: it gets the template's current skills, and
  `add_channel_skills` adds on top; `template: "none"` stops following (the channel's own
  additions stay). Preview shows what the channel would gain, keep or drop.

None of these show an approval card.

## Authoring

- `create_skill` — a new skill from files you pass (`SKILL.md` required). Use the
  `skill-authoring` skill for the frontmatter contract and a description that actually triggers.
  **Where it lives:** omit `scope` — in a channel the skill becomes a **channel skill** (active
  here, editable by its members); in a DM it becomes your **personal** skill. Pass
  `scope: "organization"` ONLY when the user explicitly asked for an organization-level (shared,
  company-wide) skill: an admin's goes straight into the shared library (and is active here);
  anyone else's is created here as a channel skill and a promotion request is filed for an
  admin. `personal: true` keeps it private to the requester. Name skills uniquely across the
  whole repository (prefix customer skills with the customer, e.g. `acme-invoice-check`). When
  Git publishing is configured the files are also pushed to the repository.
- `update_skill` — a new revision; pass the changed files (unnamed files are kept; `remove`
  deletes files). Personal: its author. Channel: any member of that channel. Organization: an
  admin applies it directly; a non-admin's edit is filed as a change proposal automatically.
  Skills synced from the gateway's own publish repository are edited too — the new revision is
  pushed back there.
- **A skill from a source this gateway cannot write to** (bundled with the gateway, another
  GitHub repository, a host folder, a peer gateway) is never edited in place — its source would
  bring the old files back. Extend it with a **companion skill** instead: `create_skill` a new
  skill (e.g. `<original>-extras`) whose description says when to use it together with the
  original, with `requires: [<original>]` in its frontmatter so the original loads with it, and
  the additional references or scripts in its own files. `update_skill` tells you when this
  applies.
- `delete_skill` — deletes a skill from the WHOLE catalog (restorable by an admin). Only an
  admin does that — or you, for your own personal skill. For anyone else it deactivates the
  skill here and files a delete request for an admin. Prefer `remove_channel_skills` when the
  user only wants it gone from this conversation.
- `propose_skill_change` — ask an admin for what you cannot do yourself: `kind: "change"`
  (files + note, for an organization skill), `"feedback"` (a note), `"promote"` (a personal or
  channel skill becomes an organization skill), `"delete"` (remove a shared skill from the
  catalog).

## Admins

- `list_skill_proposals` / `decide_skill_proposal` — review pending proposals in the thread
  (`decision: "approve" | "reject"`, optional `note`). Approving a promotion moves a channel
  skill into the shared library (or makes a personal skill an organization skill); approving a
  delete request removes the skill from the catalog.
- The organization-wide admin tools below (`decide_skill_proposal`, sources, org grants,
  governance, exclusion, `set_skill_scope`, `publish_skill`) **always** show an Approve/Deny card:
  they change every conversation at once, and a proposal's text is written by someone else.
  Auto mode and admin mode do NOT skip it.
- `sync_skill_sources` — pull the configured sources now (a source in *review* mode stages new
  revisions for approval in the admin UI; *auto* activates them).
- `list_skill_sources` / `add_skill_source` / `set_skill_source` / `remove_skill_source` — the
  sources: GitHub repositories, host folders, or a peer gateway (URL + a token minted there).
- `add_org_skills` / `remove_org_skills` — mandatory skills loaded in every conversation.
- `set_skill_governance` — enable/disable a catalog skill, approve it for organization-wide
  discovery, or make it mandatory. Mandatory implies enabled and discoverable.
- `set_skill_excluded` — hide a synced/bundled skill from the catalog (it stays hidden across syncs) or bring it back.
- `publish_skill` (managers too) — push a local skill to the configured Git repository now.
- `set_skill_scope` (admins) — move a skill between the shared library and a channel's section
  (`scope: "library"` promotes a customer skill for everyone; the channel it leaves keeps it as
  an explicit grant; `scope: "channel"` keeps it for one customer). The files move in the
  repository too.
- Templates, pins/rollbacks, staged revisions, access tokens for the catalog's MCP endpoint, the
  GitHub webhook and the usage dashboard live in the admin UI under **Skills**.
