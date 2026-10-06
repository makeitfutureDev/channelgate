---
title: Google Drive workspace sync
description: Link a Drive folder to a conversation workspace with scheduled and on-demand two-way synchronization.
---

Drive sync keeps a conversation's working folder synchronized with a selected Google Drive folder. It uses the installation's Workspace service account and `rclone bisync`, separately from an agent's personal/shared Composio Drive tools.

## Configure the installation

An administrator opens **Settings → Agent defaults → Google Drive sync** and enables scheduled sync. Paste the service-account JSON through the protected settings field, or configure an operator-managed key file. The interface shows the account's email so you can share the intended Drive folder with it.

Set the optional impersonation subject only when domain-wide delegation has been configured. Ensure the host's rclone binary is installed and its configured path is available to the service. Sync remains dormant without the master enable switch, credentials, and rclone.

The default interval is **15 minutes** and the default conflict policy is **newer**. Other policies include older, larger, local (`path1`), or Drive (`path2`); choose deliberately when both sides may edit the same document.

## Link a conversation

Open **Conversations → [conversation] → Google Drive sync folder**, enter its folder link, and save. Use **Test** to verify service-account visibility before relying on synchronization. An administrator can also ask the agent to link or unlink the folder.

The link covers the **whole working folder**, subject to exclusions. The initial pass merges both sides, with conflict handling; this is not a one-way backup.

```text
Check this channel's Drive folder and last sync status, then sync Drive now.
```

Any admitted user can request an on-demand pass for the already linked current conversation. **Sync now** in its admin page does the same; **Sync all now** in gateway settings sweeps linked conversations. Concurrent passes for the same conversation are not duplicated.

## What is excluded

Agent instructions, skills, MCP configuration, memory, secrets, key files, Git metadata, worktrees, dependency trees, and symlinks are excluded in both directions. Add more workspace-specific exclusions through a root `.driveignore` file.

A temporary sync container sees only the approved workspace and its required protected sync state. Broad roots, another channel's workspace, the operator home, and Lean-mode workspaces are refused. Editing a Drive document cannot plant managed instructions through this path.

Inspect the last-pass result: a working connection test does not prove every sync completed. Changes to the local root, Drive link, or filters trigger a fresh reconciliation. Keep independent backups for data that must survive accidental deletions.

## Related guides

- [Shared workspaces](/docs/features/shared-workspaces)
- [Gateway settings](/docs/configuration/gateway-settings)
- [Channel settings](/docs/configuration/channel-settings)
- [Backup and restore](/docs/features/backup-and-restore)
