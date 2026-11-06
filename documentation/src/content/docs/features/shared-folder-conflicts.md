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

## Linked folder setup

Selecting a folder already assigned to another conversation links to that conversation's shared setup automatically. The established folder owner remains the source even when an older conversation joins later. Existing duplicate assignments resolve to the first stored conversation.

Skills (including owner-scoped catalog skills), templates, memory settings and files, instructions, access policy, connectors, channel secrets, mode, Auto, Lean, network and Drive configuration follow the source live. Edit shared settings in the source conversation; attempts to create conflicting selections in a follower explain where to edit. Personal accounts and grants stay personal. Harness, model, effort, engine authentication and sessions remain independent.

The conversation list shows a linked-folder marker. The folder picker explains inheritance before selection; the conversation editor names the source and provides an Open source conversation button. Slack Settings also identifies the source. One owner runs Drive synchronization; follower sync requests use that same job and state.

Changing the working folder unlinks the conversation, retaining the last effective setup as its starting point. When the owner leaves, the first remaining conversation becomes the source using its saved setup. The gateway still refuses its private runtime/configuration trees and parent folders that would expose multiple workspaces. Folder assignment remains an administrator operation.

A shared folder keeps the owner's operating guide stable; a follower on another chat platform receives its actual surface capabilities in each turn's prompt.

## Confirm the effective path

Open **Files** and inspect its displayed working directory. A custom folder points at actual project files; it is not a copied snapshot. Changing a path should be deliberate and followed by a check that expected files and policy are present.

Forking a thread copies eligible session history, not the filesystem. SSH and VS Code also use the actual conversation container and mounted working directory. All collaborators must agree on edit ownership.

Related: [shared workspaces](/docs/features/shared-workspaces), [conversation forks](/docs/features/conversation-forks), [storage and runtime](/docs/configuration/storage-and-runtime), and [VS Code access](/docs/features/vscode-access).
