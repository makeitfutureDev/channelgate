---
title: Shared folders and concurrent edits
description: Prevent overlapping work from overwriting files or conflicting with managed skills and memory.
---

Threads in a conversation share files even when their engine sessions are separate. Conversations can also be pointed at the same custom working folder. These two forms of sharing need coordination.

## Keep independent edits isolated

```text
@ChannelGate Implement this change in a separate Git worktree and branch.
Another thread is reviewing the existing checkout, so preserve its uncommitted work.
```

A Git branch alone does not isolate working files. Use a distinct worktree for each editing task, coordinate file ownership among subagents, and serialize the final integration step. For non-Git output, give tasks separate destination folders or filenames.

The gateway's per-thread queue orders requests within that thread. It does not lock every project file against work in another thread or an authorized developer session.

## Align conversations sharing one folder

A working folder also contains gateway-managed instructions, shared skill materialization, and portable memory files. Two conversations pointed at that folder cannot safely impose incompatible managed selections.

ChannelGate checks compatible shared skill grants and memory settings before workspace synchronization. A conflict refuses provisioning with guidance to separate the folders or align the selections. It does not silently replace the other conversation's managed setup. The conflict notice does not disclose another conversation's identity or private folder path.

An administrator should identify every conversation assigned to the folder, compare direct grants, template-derived grants, organization grants, and memory settings, then either align them or assign separate paths. Separate paths are usually easier to reason about for unrelated projects.

## Confirm the effective path

Open **Files** and inspect its displayed working directory. A custom folder points at actual project files; it is not a copied snapshot. Changing a path should be deliberate and followed by a check that expected files and policy are present.

Forking a thread copies eligible session history, not the filesystem. SSH and VS Code also use the actual conversation container and mounted working directory. All collaborators must agree on edit ownership.

Related: [shared workspaces](/docs/features/shared-workspaces), [conversation forks](/docs/features/conversation-forks), [storage and runtime](/docs/configuration/storage-and-runtime), and [VS Code access](/docs/features/vscode-access).
