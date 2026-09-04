# Skills — the local catalog, channel profiles, templates, authoring and sources

ChannelGate keeps its own **skill catalog** in the gateway database and materializes real skill
folders into every conversation that is granted them. Skills work with no external token and no
network call at run time; Claude and Codex both discover them natively.

This is the Core (self-hosted) plane of the skills platform. The Enterprise cloud plane (a hosted
library, fleet sync, a universal Skills MCP) builds on the same catalog and is a separate offering.

## What a skill is

A folder with a `SKILL.md` (YAML frontmatter + Markdown body) and any number of sibling files
(`references/*`, `scripts/*`, `assets/*`, binaries included). The catalog stores the **exact
bytes** of every file as an immutable, content-hashed **revision**; the frontmatter fields it
indexes (name, description, category, tags, version, `requires`) are derived and rebuilt from the
bytes, never the other way round — a key the gateway does not model (for example
`allowed-tools`) is never lost.

```yaml
---
name: customer-record
description: >-
  Load, create or update a customer record. Use whenever a task names a customer, deal or
  account and needs its ids, owners or history.
category: Sales
version: 1.2.0
tags: [crm]
requires: [makeitfuture-organization]   # catalog skills granted together with this one
---
```

Every skill has one **owner**:

| owner    | how it gets in                                                                 | how it changes                                  |
| -------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| bundled  | shipped in this checkout (`src/gateway/skills/bundled/`), imported at boot     | a new gateway release                            |
| folder   | the host's `~/.claude/skills`, `~/.agents/skills` or `GATEWAY_SKILL_SOURCES`, imported at boot and re-read by content | edit the folder; the next boot / re-import picks it up |
| git      | a GitHub source (below)                                                        | the source's next sync                           |
| local    | authored from chat (`create_skill`) or the admin UI                            | `update_skill` by its author, a manager or an admin |

A slug is owned by exactly one owner. A sync or an import that finds a slug another owner holds
reports a **conflict** and writes nothing. Changing a source-owned skill goes through a
**proposal** (below). Removing a skill is a **tombstone**: its revisions stay, a conversation that
still grants it sees why it is missing, and a returning source restores it.

## Channel profiles (no tokens)

A conversation's active skills are the union of three grant tiers, resolved on every message:
the organization tier (Settings → Skills & connectors), the conversation's own grants
(Conversations → Skills, or the chat verbs), and the requester's personal grants. Dependencies
named in `requires:` are granted with a skill automatically. The resolver reports what is
missing, what is still awaiting review, dependency cycles, near-duplicate trigger descriptions,
and an estimate of the **always-on context** (every active skill's name + description rides in
every prompt; the bodies do not). A soft cap (default 6000 tokens, Settings) flags heavy profiles.

The gateway writes the resolved profile into the conversation's folder as real files
(`.claude/skills/<slug>/…`, marker-managed, write-on-change) and hands the same tree to Claude
through its plugin and to Codex through the `.agents/skills` link. A project-owned folder of the
same name always wins over the catalog copy; only folders the gateway wrote are ever updated or
pruned.

## Templates

**Development**, **Sales**, **Marketing** and **Management** are seeded; each names categories
and/or explicit skills, and admins edit or add templates in the admin UI (Skills → Templates).
Applying a template to a conversation copies a **snapshot** of the skills it resolves to at that
moment into the conversation's grants — a later template edit never changes a conversation by
itself. Preview first to see what would be added, kept or removed.

From chat (managers, or an admin): `list_skill_templates`, `preview_skill_template`,
`apply_skill_template` (`mode: add | replace`), `add_channel_skills`, `remove_channel_skills`,
`show_channel_skills`. These change persistent state and show an Approve/Deny card unless the
conversation is in auto mode.

## Sources (GitHub and host folders)

Admin UI → Skills → Sources. A **git** source is one GitHub repository, optionally a branch and a
subfolder (`https://github.com/org/repo`, or a `…/tree/<branch>/<folder>` link; a branch name with
a `/` in it is resolved against the repository's real branch list). The daemon downloads the
repository as one tarball, treats every folder holding a `SKILL.md` as a skill (a nested skill
owns its own files), and stores each as a revision. Files over 2 MB and folders over 400 files are
skipped and reported. A **folder** source is a directory on the gateway host.

- **mode = review** (default): every new or changed skill is **staged**; nothing reaches a
  conversation until an admin approves it in Skills → Review. Synced third-party skills are an
  instruction supply chain — review is the safe default.
- **mode = auto**: activates on sync.
- **pin**: freeze a git source at one commit; **enabled** off pauses it.
- Sync runs at boot (30 s after start), on the interval in Settings (default 60 minutes; 0 = off),
  on *Sync now*, and from chat with `sync_skill_sources` (admins).
- A skill removed upstream is tombstoned, never deleted. Sync errors are shown on the source and
  never discard the last-good revisions.
- A **GitHub token** (Settings, write-only) is only needed for private repositories or API rate
  limits; it never enters a conversation folder or an MCP config.

Existing host folders (`~/.claude/skills`, `~/.agents/skills`, `GATEWAY_SKILL_SOURCES`) keep
working exactly as before: they are imported at boot as folder-owned skills under their directory
names, so every stored grant still resolves. *Re-import host folders* refreshes them on demand.

## Authoring and proposals

Anyone approved to use a conversation can add a skill to the shared catalog from chat:

- `create_skill` — files (a `SKILL.md` with name + description, plus references/scripts) → a
  local skill, granted in that conversation at once. The bundled `skill-authoring` skill teaches
  the contract and how to write a description that triggers.
- `update_skill` — a new revision of a local skill you created (managers and admins: any local
  skill). Pass only the files that change; the rest are carried over (`remove` drops files).
- `propose_skill_change` — for a skill you may not edit directly: the changed files and a note
  (`kind: change`), or a request to grant a skill organization-wide (`kind: promote`).
- Admins review with `list_skill_proposals` / `decide_skill_proposal` in chat, or in the admin UI
  (Skills → Review). An approved change becomes one revision; when the skill is source-owned the
  revision is **pinned** as a local override, so the source keeps flowing into later revisions
  and the pin holds until an admin unpins. An approved promotion adds the skill to the
  organization tier.
- Pins double as **rollback**: pin any active revision from the catalog view; *follow current*
  unpins.

## Usage

Every run records which skills fired. Claude's `Skill` tool gives an **exact** signal; Codex has
no such tool and reads the `SKILL.md` file, so a read or shell command touching
`…/skills/<slug>/SKILL.md` is recorded as **inferred** and labelled so. Rows carry
skill/revision/conversation/user/engine/session/run and the signal — never prompt text or skill
content. `skill_usage_report` in chat and Skills → Usage in the admin UI show what fired and,
more usefully, which granted skills **never** fired; the per-conversation profile table shows
each conversation's always-on context cost.

## Personal skills

`create_skill` with `personal: true` (or the *Make personal* switch in the admin UI) keeps a skill
visible and grantable only to its author; admins see everything. Personal skills are granted to
the author's own tier on creation, are never published to Git and never leave the gateway over
MCP. A `promote` proposal, once approved, turns a personal skill into an organization skill (and
publishes it). Any approved member can also carry organization skills in their own runs with
`add_my_skills` / `remove_my_skills` — the user tier of the grant union, no approval card.

## Publishing to Git

Admin UI → Skills → Sources → *Publishing to Git*: a GitHub repository (owner/repo), branch and
folder. With the daemon's GitHub token set, every new revision of a local skill — created,
updated, an approved change, an approved promotion — is pushed with the GitHub Contents API, one
commit per file under `<folder>/<slug>/`, and files a newer revision dropped are deleted. The
revision records the commit. When the publish repository is also a configured git source, the
published skill is **adopted** by that source (it becomes a synced skill of that source), so the
next sync recognises its own files instead of reporting a conflict: authored in chat, pushed to
GitHub, part of the library. `publish_skill` (managers) and *Publish to Git now* push on demand.
Publishing is best effort: a failure is reported in the reply and logged, never blocks a turn.

## Webhook-triggered sync

`POST <public URL>/api/skills/webhook/github` accepts GitHub push webhooks (JSON, secret = the
webhook secret in Skills → Sources). The signature is verified over the raw body; the pushed
repository is matched against the git sources and each match is synced a few seconds later
(bursts are coalesced). `ping` events answer without syncing. The interval sync keeps running.

## The catalog over MCP (laptop Claude Code, Codex, other clients)

`POST <public URL>/mcp/skills` is a stateless Streamable HTTP MCP endpoint for the catalog. It
authenticates a bearer **access token** minted in Skills → Sources → *MCP endpoint & access
tokens*: random, shown once, stored hashed, revocable, with scopes:

| scope   | tools                                                                                  |
| ------- | -------------------------------------------------------------------------------------- |
| read    | `library_search_skills` (facets + pagination), `library_get_skill_info`, `library_get_skill_file`, `library_list_templates`, `library_whoami` |
| propose | `library_suggest_skill_change` (changed files + note, or feedback with a note only)     |
| manage  | `library_create_skill`, `library_update_skill`                                          |
| sync    | `library_export`, `library_export_skill` (what a peer gateway needs)                    |

Claude Code: `claude mcp add --transport http channelgate-skills <public URL>/mcp/skills --header
"Authorization: Bearer <token>"`. Personal skills never appear over MCP.

## Peer gateways

A source of kind **gateway** (Skills → Sources → *Another ChannelGate*) is a peer's URL plus a
token minted on that peer with the `sync` scope (stored write-only). Sync pulls the peer's
organization skills through its MCP endpoint — staged in review mode, active in auto mode,
tombstoned when the peer drops them, last-good kept on failure. Two gateways on one host share a
library with nothing but a URL and a token.

## Migrating from Skills Manager

The Skills Manager runtime integration was retired on 2026-09-05; Skills Manager remains a
standalone product. `node scripts/migrate-skills-manager.mjs [--dry-run]`, run on the gateway host
with the gateway's environment, uses the Skills Manager tokens the old integration stored:

1. every Skills Manager repository becomes a git source (auto mode) and is synced — a private
   repository needs the GitHub token (settings, `--github-token`, or the host's `gh auth token`,
   which the script stores when none is set);
2. the organization token's effective favorites become the organization tier, a channel token's
   favorites that channel's grants, a user token's favorites that user's own tier;
3. with `SM_SUPABASE_URL` + `SM_SUPABASE_SERVICE_KEY` (Skills Manager's service role): team
   favorites become templates (Development; Sales & Marketing → sales and marketing; Management;
   Admin), admin exclusions become tombstones, and each token user's personal skills become
   personal local skills.

The script is idempotent and prints what it would do with `--dry-run`. Stub folders the old
integration left in channel folders are pruned automatically on each channel's next message.

## Admin API

All routes sit under `/api/skills/…` (admin session): `overview`, `catalog` (list, detail, `file`,
create/update, pin, remove/restore), `staged` + `revisions/:id/approve|reject|files`, `sources`
(CRUD, `:id/sync`, `sync-all`, `refresh-host`), `templates` (CRUD, `:slug/preview`, `:slug/apply`),
`profile/:channel` (+ `grant`, `revoke`), `profiles`, `usage`, `proposals` (+ `approve|reject`),
`org/grant`, `org/revoke`, `tokens` (create returns the value once, `:id/revoke`, delete),
`catalog/:slug/visibility`, `catalog/:slug/publish`. Public (self-authenticating): `POST /mcp/skills`,
`POST /api/skills/webhook/github`. Settings: `skillsGithubToken` (write-only,
`clearSkillsGithubToken`), `skillsSyncIntervalMinutes`, `skillsContextWarnTokens`,
`skillsPublishRepo` / `skillsPublishBranch` / `skillsPublishSubpath` / `skillsPublishMode`,
`skillsWebhookSecret` (write-only, `clearSkillsWebhookSecret`).

## Where things live

- `src/gateway/skills/` — `catalog.js` (SQLite store), `frontmatter.js`, `files.js` (bundle rules
  and hashing), `resolve.js` (profiles, dependencies, context estimate), `materialize.js`,
  `import-folder.js`, `git-sync.js`, `templates.js`, `usage.js`, `authoring.js`, `index.js` (boot
  and the sync timer), `bundled/` (the starter library).
- `src/mcp/tools/skills.js` — the chat verbs; `src/web/routes/skills.js` — the admin API;
  `public/admin-skills.js` — the admin UI view; migration 14 in `src/db/migrations.js`.
- Round two: `publish.js`, `tokens.js`, `peer-sync.js`, `src/web/skills-mcp.js` (the MCP endpoint
  and the webhook), `scripts/migrate-skills-manager.mjs`, migration 15.
- Tests: `test/skills-platform.test.js`, `test/skills-admin-api.test.js`, `test/skills-standalone.test.js`,
  `test/folders-skills.test.js`.
