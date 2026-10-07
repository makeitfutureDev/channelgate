---
title: Skill controls
description: All thirty conversation catalog, grant, authoring, governance, and source controls.
---

These are gateway control tools available according to the run capability. Read operations obey catalog visibility; mutations also enforce their ownership tier. Administrator/control-plane operations can require the normal approval path, while personal and conversation skill changes are immediate and must be announced. Returned chat text is bounded to 12,000 characters.

File input uses package-relative paths and text by default; declare `encoding: "base64"` only for actual binary package content. This is a catalog file format, not a way to bypass file-staging rules for connected apps.

## list_skills

Search skills by slug, name, description, tags, category, or source.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `query` | No | Text search; default empty. |
| `category` | No | Category filter; default empty. |
| `source` | No | Source ID or case-insensitive label; default empty. |
| `limit` | No | Integer 1–200; default 60. |

**Authority and scope:** Available to an admitted request in its current conversation; catalog visibility is checked for the verified author.

**Result:** Text matches, categories, owners and versions, sorted by 30-day usage then slug.

**Restrictions:** Ordinary members see discoverable or already-active skills; administrators see all. Administrators can inspect all catalog entries; ordinary members can see only their own personal packages. Unknown source returns a diagnostic.

## get_skill_info

Inspect package metadata without loading the body.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `skill` | Yes | Catalog slug or name. |

**Authority and scope:** Available to an admitted request in its current conversation; catalog visibility is checked for the verified author.

**Result:** Owner, visibility, category, version, tags, dependencies, effective revision, files and revision statuses.

**Restrictions:** The package must be visible to the author. No approved revision means no active file bundle.

## show_channel_skills

Inspect the effective skill profile for this request.

**Arguments:** none.

**Authority and scope:** Available to an admitted request in its current conversation; catalog visibility is checked for the verified author.

**Result:** Grants labeled by tier, template, dependencies, staged/missing/removed skills, compatibility notes and context estimate.

**Restrictions:** Includes the current author’s personal grants. Estimated context is a soft warning, not a permission limit.

## get_skill_file

Read one file from the effective package revision without granting it.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `skill` | Yes | Catalog slug or name. |
| `file` | No | Package-relative path; default `SKILL.md`. |

**Authority and scope:** Available to an admitted request in its current conversation; catalog visibility is checked for the verified author.

**Result:** Bounded text content or a binary-file description.

**Restrictions:** Uses the effective revision, including a pin. Text is clipped at 12,000 characters; binary bytes are not returned by this chat tool.

## add_channel_skills

Activate or reactivate catalog packages in this conversation.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `slugs` | Yes | Nonempty array of catalog slugs. |

**Authority and scope:** Any member admitted to this conversation. No approval card is required; announce the shared change.

**Result:** Added/reactivated names, ignored inputs, dependencies, context estimate and warnings.

**Restrictions:** Personal packages cannot be conversation grants. Missing, deleted or invisible packages are ignored. Approved eligible packages load on the next message.

## remove_channel_skills

Deactivate selected packages here while preserving the catalog.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `slugs` | Yes | Nonempty array of slugs. |

**Authority and scope:** Any member admitted to this conversation. No approval card is required; announce the shared change.

**Result:** Removed grants, local deactivations, remaining organization/dependency reasons and current grants.

**Restrictions:** Template/channel-section packages are deactivated only here. Organization grants and required dependencies cannot be detached this way. Effective next message.

## add_my_skills

Grant packages to the author across their conversations.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `slugs` | Yes | Nonempty array of visible catalog slugs. |

**Authority and scope:** The verified requesting person, for their own grants. No HTTP API personal principal.

**Result:** Added names, dependencies, ignored names and resulting personal grants.

**Restrictions:** Approved users or administrators only. Personal skills must be visible to this author. Effective on their next message.

## remove_my_skills

Remove the author’s own grants.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `slugs` | Yes | Nonempty array of slugs. |

**Authority and scope:** The verified requesting person, for their own grants. No HTTP API personal principal.

**Result:** Removed names, remaining personal grants and still-required dependency reasons.

**Restrictions:** Does not change organization or conversation grants. A verified person is required.

## list_skill_templates

List centrally maintained template definitions.

**Arguments:** none.

**Authority and scope:** Available to an admitted request in its current conversation; catalog visibility is checked for the verified author.

**Result:** Names, slugs, descriptions, resolved skills, categories and missing names.

**Restrictions:** Returns currently resolved contents; existence of a template does not activate it.

## preview_skill_template

Calculate a template’s effect without writing.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `template` | Yes | Template slug or name. |

**Authority and scope:** Available to an admitted request in its current conversation; catalog visibility is checked for the verified author.

**Result:** Gained/kept/dropped skills, missing names and separate template-tier/effective context estimates.

**Restrictions:** Keeps the conversation’s own additions. Unknown template returns a diagnostic. No settings change.

## update_skill_template

Change the explicit skill selection in an existing template.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `template` | Yes | Existing template slug or name. |
| `add` | No | Array of slugs; default empty. |
| `remove` | No | Array of slugs; default empty. |

**Authority and scope:** Organization administrator; the shared control-plane approval policy applies to mutations.

**Result:** Added/refused/removed names and new resolved contents.

**Restrictions:** At least one addition or removal is needed. Unknown/deleted/personal additions are refused. All following conversations receive the change on their next message.

## set_channel_skill_template

Make this conversation follow a template live.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `template` | Yes | Template slug/name; `none` stops following. |

**Authority and scope:** Any member admitted to this conversation. No approval card is required; announce the shared change.

**Result:** Assigned template, effective skill list, changes and context estimate; or no-template confirmation.

**Restrictions:** Conversation must exist. Own additions remain; inherited organization/personal grants are independent. Effective next message.

## create_skill

Create a versioned skill package.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `slug` | No | Folder name; default slugified frontmatter name. |
| `files` | Yes | Nonempty file array. Each file is `{path, content, encoding?}`: path and content required; encoding is `utf8` or `base64` (omitted means text). Paths are inside the package. |
| `note` | No | Revision note; default empty. |
| `grant_here` | No | Default true; controls a directly created organization package’s local grant. |
| `personal` | No | Default false. Makes an author-private skill; cannot combine with channel scope. |
| `scope` | No | `channel`, `organization`, or alias `library`; omitted selects channel in a channel and personal in a DM (API principal has no personal scope). |

**Authority and scope:** Approved author. Personal owner and admitted channel members create locally without approval. Administrators create organization packages directly; a non-admin organization request starts locally and files a promotion proposal.

**Result:** Slug, revision/file count, scope/grant state, publication result and optional proposal ID.

**Restrictions:** Requires `SKILL.md` with name and description. Read the skill-authoring workflow first. Organization scope must reflect an explicit user request; active on the next message.

## update_skill

Create a new revision using partial file updates.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `skill` | Yes | Visible catalog slug/name. |
| `files` | Yes | Nonempty changed-file array. Each file is `{path, content, encoding?}`: path and content required; encoding is `utf8` or `base64` (omitted means text). Paths are inside the package. |
| `remove` | No | Array of file paths to remove; default empty. |
| `note` | No | Revision note; default empty. |

**Authority and scope:** Personal owner, members of the owning channel, or administrator. A member’s organization edit becomes a proposal.

**Result:** New revision/file count, unchanged result, publication/pin status, or proposal ID.

**Restrictions:** Unspecified files stay. Non-writable source packages require a companion skill. File removals cannot ride the automatic organization-change proposal; describe them to the reviewer.

## delete_skill

Tombstone a package from the catalog or request shared deletion.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `skill` | Yes | Visible catalog slug/name. |

**Authority and scope:** Administrator for deletable authored packages, or owner of a personal skill; other approved authors request deletion.

**Result:** Catalog removal, or local deactivation plus a delete proposal ID.

**Restrictions:** Shared catalog deletion is admin-moderated and restorable. For a member’s local “delete,” prefer remove_channel_skills. External-source editability still applies.

## propose_skill_change

Submit a change that needs administrator review.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `skill` | Yes | Target slug/name. |
| `note` | Yes | Explanation of requested change. |
| `files` | No | Changed-file array; default empty. Each file is `{path, content, encoding?}`: path and content required; encoding is `utf8` or `base64` (omitted means text). Paths are inside the package. |
| `kind` | No | `change` (default), `feedback`, `promote`, `delete`, or `template`. |
| `template` | No | Template slug/name for kind `template`; default empty. |

**Authority and scope:** Approved author, recorded against this conversation.

**Result:** Proposal ID, kind, target and owner; no approved revision changes until decided.

**Restrictions:** Template kind needs a valid template. Feedback is note-only. Promotion requests wider scope or organization-wide assignment rather than bypassing governance.

## list_skill_proposals

Inspect review proposals.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `status` | No | `pending` (default), `approved`, `rejected`, or `all`. |

**Authority and scope:** Administrator.

**Result:** Proposal IDs, kind, author, conversation, state, file paths and notes.

**Restrictions:** Lists proposals, not the separate staged source-revision approval queue. Text is bounded.

## decide_skill_proposal

Approve or reject a proposal.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `id` | Yes | Integer proposal ID. |
| `decision` | Yes | `approve` or `reject`. |
| `note` | No | Decision note; default empty. |

**Authority and scope:** Organization administrator; the shared control-plane approval policy applies to mutations.

**Result:** Decision and resulting revision, local pin, promotion, deletion, template assignment or publication result.

**Restrictions:** Approval effects depend on kind. Source changes can be pinned locally. Rejected requests do not become effective.

## set_skill_scope

Move a package between the library and a channel section.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `skill` | Yes | Visible catalog slug/name. |
| `scope` | Yes | `library` or `channel`. |
| `channel` | No | Channel slug for channel scope; default current conversation. |

**Authority and scope:** Organization administrator; the shared control-plane approval policy applies to mutations.

**Result:** Scope change, repository path move and preserved grant, or already-in-scope result.

**Restrictions:** Channel scope needs an existing non-DM conversation. Only locally authored packages or packages owned by the configured publishing repository can move; personal packages must first become shared. A move can relocate repository files. A channel leaving a package in the library retains an explicit grant.

## publish_skill

Push the current eligible revision to the configured Git destination.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `skill` | Yes | Visible catalog slug/name. |

**Authority and scope:** Current channel manager or administrator; control-plane approval policy applies.

**Result:** Repository, branch, path, file/deletion counts and source adoption, or refusal/failure reason.

**Restrictions:** Uses the configured destination only. Publishing must be enabled and ownership/credential checks must pass; save and publication outcomes are separate.

## skill_usage_report

Report recorded skill use in this conversation.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `days` | No | Integer 1–365; default 30. |

**Authority and scope:** Available to an admitted request in its current conversation; catalog visibility is checked for the verified author.

**Result:** Totals, exact time window, recorded attribution, inferred-read provenance and unused shared grants.

**Restrictions:** Missing historical identities stay unknown. Reports are bounded text and do not represent a complete task cost.

## add_org_skills

Grant packages organization-wide.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `slugs` | Yes | Nonempty array of catalog slugs. |

**Authority and scope:** Organization administrator; the shared control-plane approval policy applies to mutations.

**Result:** Added names, resulting organization list and required dependencies.

**Restrictions:** Deleted, unknown and personal packages are not grantable. All conversations receive eligible grants on their next message.

## remove_org_skills

Stop organization-wide grants.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `slugs` | Yes | Nonempty array of slugs. |

**Authority and scope:** Organization administrator; the shared control-plane approval policy applies to mutations.

**Result:** Removed names, remaining organization grants and still-required dependencies.

**Restrictions:** Other conversation/personal grants remain. Dependencies still required by another organization grant cannot be detached alone.

## set_skill_governance

Set enabled, discoverable, and mandatory state.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `skill` | Yes | Catalog slug/name. |
| `enabled` | No | Boolean; omitted leaves current state. |
| `discoverable` | No | Boolean; omitted leaves current state. |
| `mandatory` | No | Boolean; omitted leaves current state. |

**Authority and scope:** Organization administrator; the shared control-plane approval policy applies to mutations.

**Result:** Final enabled/discoverable/mandatory state.

**Restrictions:** Mandatory implies enabled and discoverable. Disabling excludes and revokes organization assignment. Cannot hide a still-mandatory package. Effective next message.

## list_skill_sources

Inspect source configuration and synchronization state.

**Arguments:** none.

**Authority and scope:** Administrator.

**Result:** Source IDs, kinds, labels, URLs, refs/folders, mode, enabled/pinned state, last sync statistics/errors.

**Restrictions:** Source secrets are not echoed. Use IDs for targeted changes.

## add_skill_source

Register and immediately synchronize an external source.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `kind` | Yes | `git`, `folder`, or `gateway`. |
| `url` | Yes | Repository URL, host folder path, or peer gateway URL. |
| `label` | No | Display label; default empty. |
| `ref` | No | Git branch/ref; default empty, letting repository resolution choose. |
| `subpath` | No | Source folder; default empty. |
| `mode` | No | `review` (default) or `auto`. |
| `token` | No | Peer gateway access token with `sync` scope; default empty; never echoed. |

**Authority and scope:** Organization administrator; the shared control-plane approval policy applies to mutations.

**Result:** Source ID and first import counts/conflicts, or saved-source/failed-sync diagnosis.

**Restrictions:** Review stages eligible revisions rather than activating them. Git private-source credentials can be configured in the admin source form; token here is documented for peer access.

## set_skill_source

Update source policy without replacing its secret.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `id` | Yes | Integer source ID. |
| `mode` | No | `review` or `auto`; omitted unchanged. |
| `enabled` | No | Boolean; omitted unchanged. |
| `pinned_ref` | No | Pinned commit/ref; omitted unchanged, empty clears it. |
| `label` | No | Display label; omitted unchanged. |

**Authority and scope:** Organization administrator; the shared control-plane approval policy applies to mutations.

**Result:** Updated source ID, mode, enabled and pinned state.

**Restrictions:** Does not itself expose credentials or guarantee a sync. Pinning affects future source imports.

## remove_skill_source

Remove a configured source and tombstone its packages.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `id` | Yes | Integer source ID. |

**Authority and scope:** Organization administrator; the shared control-plane approval policy applies to mutations.

**Result:** Source ID and tombstoned package count.

**Restrictions:** Tombstoned packages stop loading; history is restorable. This is wider than revoking one conversation grant.

## set_skill_excluded

Persistently exclude or restore a source/bundled package.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `skill` | Yes | Catalog slug/name. |
| `excluded` | Yes | Boolean: true excludes, false restores. |

**Authority and scope:** Organization administrator; the shared control-plane approval policy applies to mutations.

**Result:** Excluded/included confirmation.

**Restrictions:** Exclusion survives imports and sync until explicitly cleared. Restoration is separate from adding a new grant.

## sync_skill_sources

Synchronize configured sources now.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `id` | No | Integer source ID; omitted synchronizes configured sources. |

**Authority and scope:** Organization administrator; the shared control-plane approval policy applies to mutations.

**Result:** Per-source discovered/new/updated/staged/unchanged/removed counts, conflicts or errors.

**Restrictions:** Review mode still stages changes. Empty configuration returns a diagnostic; disabled/pinned policies remain in force.

## Related guides

[Skill discovery](/docs/features/skill-discovery), [grants](/docs/features/skill-grants), [authoring](/docs/features/skill-authoring), [sources](/docs/features/skill-synchronization), and [usage](/docs/features/skill-usage).
