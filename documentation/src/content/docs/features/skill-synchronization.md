---
title: Skill sources and synchronization
description: Import workflows from Git repositories, host folders, or peer gateways.
---

Sources feed versioned packages into the local catalog. Administrators configure them under **Admin → Skills → Sources**; a source is separate from the conversations that receive its skills.

## Add a source

Supported kinds are `git`, `folder`, and `gateway`. The admin Add source form offers GitHub and Other ChannelGate. Folder sources use configured host roots and re-import or the authorized source tools; they are not an option in that dropdown. A Git source accepts a repository URL, including a branch/folder tree link. A folder source reads a configured host directory. A peer gateway needs its URL and a skills access token minted there with the `sync` scope.

```text
Add this public skills repository as a source in review mode, restricted to its skills folder. Show the first synchronization result.
```

The chat `add_skill_source` call defaults to **review** and synchronizes immediately. New or changed packages are staged in review mode; **auto** activates eligible revisions during sync. Private Git credentials can be entered in the admin source form. The peer access token is never echoed.

## Keep it current

**Sync settings → Synchronization** has a manual sync, host-folder re-import, and **Sync interval**. The default interval is 60 minutes; `0` disables scheduled sync, and the supported maximum is 1,440 minutes. Administrators can sync all configured sources or one source ID through `sync_skill_sources`.

A GitHub push webhook at `/api/skills/webhook/github` supports faster updates. Configure the gateway's public URL and webhook secret in the Sync settings tab, then add a GitHub JSON push webhook using the same secret. The endpoint verifies the HMAC signature before selecting matching enabled Git sources.

## Pin and troubleshoot

A source can be disabled, switched between review/auto, relabeled, or pinned to a commit. Check **last sync**, errors, conflicts, and staged revisions before assuming an import became active. A skill-level pin can keep a historical revision effective even while source sync succeeds.

Removing a source tombstones its skills; it does not erase their revision history. Excluded packages remain excluded across syncs. A source supplies files, not provider connections or elevated tool authority.

Related: [source configuration](/docs/configuration/skill-sources), [reviews](/docs/features/skill-reviews), [publishing](/docs/features/skill-publishing), and [source controls](/docs/controls/skills#list_skill_sources).
