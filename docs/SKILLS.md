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
| git      | a GitHub source (below)                                                        | the source's next sync; a skill of the gateway's own publish repository also takes `update_skill` (pushed back) |
| local    | authored from chat (`create_skill`) or the admin UI                            | `update_skill` — see *Who may change what* below  |

A slug is owned by exactly one owner. A sync or an import that finds a slug another owner holds
reports a **conflict** and writes nothing. A skill whose source this gateway cannot write to
(bundled, a host folder, another repository, a peer gateway) is never edited in place — it is
extended with a companion skill that `requires:` it, or changed by an admin-approved **proposal**
(below). Removing a skill is a **tombstone**: its revisions stay, a conversation that
still grants it sees why it is missing, and a returning source restores it. A skill an admin
removed (the Skills view, `set_skill_excluded`, a migrated Skills Manager exclusion) is an
**exclusion**: it stays out across syncs and imports until an admin restores it.

## Channel profiles (no tokens)

A conversation's active skills are the union of three grant tiers, resolved on every message:
the mandatory organization tier, the conversation's own grants
(Conversations → Skills, or the chat verbs), and the requester's personal grants. Dependencies
named in `requires:` load with the skill that requires them, on every message — they are resolved,
never stored: a grant list holds only what was explicitly granted, so a dependency stays reported
as *required by* its parent rather than as a grant of that tier, and revoking the parent takes it
along instead of stranding it. Granting a dependency on its own is an ordinary grant and outlives
its parent. The resolver reports what is
missing, what is still awaiting review, dependency cycles, near-duplicate trigger descriptions,
and an estimate of the **always-on context** (every active skill's name + description rides in
every prompt; the bodies do not). A soft cap (default 6000 tokens, Settings) flags heavy profiles.

Unavailable grants and dependencies are omitted from the run's instructions rather than blocking
the whole turn. The reply warns which skills could not load; available skills still work in both
Claude and Codex, including after failover. Awaiting-review and removed entries do not load their
bodies. Stored grants remain intact for later restoration. This availability handling does not
relax ownership or runtime confinement: another author's private grant/dependency still rejects.

The gateway writes the resolved profile into the conversation's folder as real files
(`.claude/skills/<slug>/…`, marker-managed, write-on-change) and hands the same tree to Claude
through its plugin and to Codex through the `.agents/skills` link. A project-owned folder of the
same name always wins over the catalog copy; only folders the gateway wrote are ever updated or
pruned.

### Sections: the shared library and one folder per channel

The skills repository has one **shared library** (the publish folder, `.` = the repository root)
and one **section per channel** at `channels/<channel id>/<slug>/`. The Slack channel *id* is the
key — never the name, which gets renamed and collides. A skill in a channel's section belongs to
that channel's tier automatically (with the template and the conversation's own additions), on
every gateway that syncs the repository and hosts the channel; nothing is stored per channel.
Skills in a section are ordinary catalog skills otherwise: an admin can still grant one to a second
channel of the same customer.

New skills created from a channel are **channel skills** by default: `create_skill` without a
scope keeps them in that channel's section (in a DM, the requester's personal tier), with no
question asked. `scope: "organization"` puts a skill in the shared library — directly for an
admin, and for anyone else as a channel skill plus a `promote` proposal an admin decides.
A conversation turns any of its template or section skills off **for itself** with
`remove_channel_skills` (stored as `skillsOff` in its metadata; the skill stays in the catalog and
in every other conversation) and back on with `add_channel_skills`. `set_skill_scope` (admins), the admin UI's *Section* control and
`POST /api/skills/catalog/:slug/scope` move a skill either way: **promoting** a customer skill to
the library moves its files in the repository and leaves the channel with an explicit grant, so
nothing changes there; demoting keeps it for that channel only. Only skills the publish
repository owns (or unpublished local ones) move — a skill synced from another source stays with
its source. Names must be unique across the whole repository (the slug comes from the skill's
name), so customer skills are prefixed with the customer.

## Templates

**Development**, **Sales**, **Marketing** and **Management** are seeded; each is a named skill
set — explicit catalog skills (a checklist) plus every catalog skill in its categories — edited
under Settings → Access Templates → *Skill templates*, where admins add more (Support, Legal, …).

A conversation **follows** one template: Conversations → Tools → *Skill template* (or
`set_channel_skill_template` from chat). Its channel tier is the
template's **current** skills plus the skills added to the conversation itself, so a template
edit reaches every conversation that follows it, and "add this skill to the channel" always adds
on top. The organization and personal tiers union in as before. `template: none` stops
following; the conversation's own additions stay. DM templates (User / Admin) can name a skill
template too. Preview first to see what a conversation would gain, keep or drop.

Templates store explicit skill selections; category is catalog metadata used for filtering, not a
bulk template selector. A template is also what a "team's skills" means — there is no separate
team scope. Only admins edit a template (the admin UI, or `update_skill_template` from chat, which
carries a card like the other organization-wide admin verbs); anyone may ask with
`propose_skill_change` `kind: template` + `template`, stored in the proposal's `target` column
(migration 31), and an approved request adds the skill to that template. Personal skills never join
a template. From chat: `list_skill_templates`, `preview_skill_template` and
`show_channel_skills` (which names the template and marks which skills come from it) are open
reads. `set_channel_skill_template`, `add_channel_skills` and `remove_channel_skills` are open to
any member of the conversation and post no approval card (operator decision 2026-09-27: a
channel's skill set is its members'); every change is audited (`skill_granted`,
`skill_revoked`, `skill_template_assigned`) and announced in the reply.

## Plugin packages in the same library

Add a plugin repository under **Skills → Sources**, just like a skill source. For a host folder,
use `add_skill_source` or the admin API (`POST /api/skills/sources`, `kind: "folder"`,
`url: "/absolute/source/directory"`); it then appears in the same Sources view.
A `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` identifies a package. Git sources
can contain several packages; folder sources accept a package root or immediate package children.
ChannelGate stores each package as **one catalog item and one immutable revision**. Its nested
skills are not imported separately. The Plugin badge and component summary appear in the existing
catalog, Review queue, templates, and conversation picker. Review mode stages the entire package;
approval, pins/rollback, source removal, personal grants, and template assignment use the existing
controls. An automatic source activates package updates on sync, as it does ordinary skills.

The synthetic root `SKILL.md` indexes the package. Original files are inspectable under `package/`
in the revision browser. Publishing unwraps the package to its original source layout. Package
files marked executable must be updated directly in the source repository: the current GitHub
Contents publisher cannot preserve executable modes and refuses those package writes before editing.
Package metadata is derived from the manifest on every revision; imported connection bodies never appear
in listing summaries. Invalid, oversized, or symlink-containing packages fail source sync while
retaining the last approved revision. Executable-bit changes also produce a new revision.

Runtime support is checked before execution:

- **Claude:** native skills, commands, agents, and hooks. Hooks require an authorized live admin
  turn in a Full-access conversation; unattended runs and non-admin turns cannot activate them.
- **Codex:** an explicit catalog of approved plugin skills and configured MCP transports. Native
  commands, agents, and hooks are refused with a compatibility error. A manifest's presence is
  format metadata, not a promise that every component works on that engine.
- **MCP:** reviewed HTTP(S) or stdio definitions join the run's explicit MCP configuration under
  collision-resistant `cg_plugin_…` names. Stdio requires Worker/Full-access permissions. Package
  root variables (`${PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_ROOT}`, `${CODEX_PLUGIN_ROOT}`) resolve to
  that channel's compiled artifact tree. Source authentication/environment fields and unsupported
  transports require an independently selected, supported connection with the source server's
  name. Plugin grants do not connect accounts or import source credentials. Existing connection
  restrictions still apply; arbitrary authenticated plugin transport configuration is unsupported.
- **Apps, LSP servers, and engine settings overrides:** retained for review but unsupported at
  runtime. Such packages fail explicitly instead of loading partially.

All executable artifacts remain inside the channel's mounted artifact directory. Shared packages
use content-addressed snapshots verified against catalog bytes on each run; personal packages use
run-private paths removed at completion. An update changes the warm-process fingerprint. Revoking
a grant removes its native directories, skill catalog, and MCP definitions from the next run;
previously read text remains in the conversation history, as with ordinary skills. Clean mode
supplies no plugin grants. A plugin's raw MCP files are never an ambient engine configuration.

See the plugin acceptance cases in `TEST-PLAN.md` and the disposable fixtures under
`test/fixtures/plugins/`.

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
- A skill removed upstream is tombstoned, never deleted, and comes back when upstream delivers it
  again; a skill an admin excluded does not. Sync errors are shown on the source and never discard
  the last-good revisions.
- A GitHub source follows `main`; append `/tree/main/<path>` to its URL to limit discovery to a
  subfolder. Its optional **source token** is write-only and is used only for that repository
  (private repositories or API rate limits); it never enters a conversation folder or MCP config.

Existing host folders (`~/.claude/skills`, `~/.agents/skills`, `GATEWAY_SKILL_SOURCES`) keep
working exactly as before: they are imported at boot as folder-owned skills under their directory
names, so every stored grant still resolves. *Re-import host folders* refreshes them on demand.

## Authoring and proposals

### Who may change what

| tier         | where it lives                              | create / edit                           | deactivate here | delete from the catalog |
| ------------ | ------------------------------------------- | --------------------------------------- | --------------- | ----------------------- |
| personal     | the author's own tier                       | its author                              | —               | its author, or an admin |
| channel      | the channel's section (`channels/<id>/…`)   | any member of that channel              | any member      | an admin (a member files a `delete` request) |
| organization | the shared library                          | an admin; anyone else files a proposal  | any member (for their conversation) | an admin |

Personal and channel changes never post an approval card and never wait for anyone (operator
decision 2026-09-27); the tool result tells the model to announce the change in its reply, and
every write is audited (`skill_created`, `skill_updated`, `skill_revoked`, `skill_removed`).
Admins moderate only the organization tier; the organization-wide admin verbs
(`decide_skill_proposal`, `update_skill_template`, `add_org_skills` / `remove_org_skills`, sources, governance, exclusion,
`set_skill_scope`, `publish_skill`) **always** post an Approve/Deny card.
Auto mode does not bypass it: auto-approval applies to tool permission prompts only, never to
control-plane changes.
Accepted residual risk: content injected into an
authorized turn can write a skill that loads in that channel's (or that author's) later turns;
it can never reach the organization tier.

- `create_skill` — files (a `SKILL.md` with name + description, plus references/scripts) → a
  channel skill by default (personal in a DM, `scope: "organization"` for the shared library as
  above). The bundled `skill-authoring` skill teaches the contract and how to write a
  description that triggers.
- `update_skill` — a new revision. Pass only the files that change; the rest are carried over
  (`remove` drops files). A local skill is revised in place; a skill synced from the configured
  publish repository is revised and pushed back to its own folder (if the push fails the new
  revision is pinned, so the next sync cannot revert it). A skill pinned to an older revision is
  re-pinned to the new one. A non-admin's edit of an organization skill becomes a `change`
  proposal automatically. Any other source is read-only: `update_skill` explains how to extend
  it with a companion skill.
- `delete_skill` — a catalog tombstone: an admin, or the author of a personal skill. Anyone else
  deactivates the skill in their conversation and files a `delete` proposal.
- `propose_skill_change` — ask an admin: the changed files and a note (`kind: change`), a
  promotion (`kind: promote` — a personal or channel skill becomes an organization skill; an
  organization skill gets granted everywhere), a catalog delete (`kind: delete`), or feedback.
- Admins review with `list_skill_proposals` / `decide_skill_proposal` in chat, or in the admin UI
  (Skills → Review). An approved change becomes one revision; when the skill is source-owned the
  revision is **pinned** as a local override, so the source keeps flowing into later revisions
  and the pin holds until an admin unpins. An approved promotion moves a channel skill into the
  library (the channel keeps it as an explicit grant), makes a personal skill an organization
  skill, or adds an organization skill to the organization tier; an approved `delete` tombstones
  the skill.
- Pins double as **rollback**: pin any active revision from the catalog view; *follow current*
  unpins.

## Usage

Every run records which skills fired. Claude's `Skill` tool gives an **exact** signal; Codex has
no such tool and reads the `SKILL.md` file, so a read or shell command touching
`…/skills/<slug>/SKILL.md` is recorded as **inferred** and labelled so. Rows carry
skill/revision/conversation/user/engine/session/run and the signal — never prompt text or skill
content. `skill_usage_report` in chat and Skills → Usage in the admin UI show one usage total and,
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

Admin UI → Skills → Sync settings → *Publishing to Git*: a GitHub repository, folder and its own
write-only token. Publishing follows `main`. Every new revision of a local skill — created,
updated, an approved change, an approved promotion — is pushed with the GitHub Contents API, one
commit per file under `<folder>/<slug>/` (`.` as the folder = the repository root) — or under
`channels/<channel id>/<slug>/` for a channel-scoped skill, with a README naming the channel — and
files a newer revision dropped are deleted. A skill the publish repository already owns is written
back to the folder it was synced from. The
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
(CRUD, `:id/sync`, `sync-all`, `refresh-host`), `templates` (CRUD, `:slug/preview`, `:slug/assign`), `profile/:channel/template` (assign or clear),
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
