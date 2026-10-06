---
title: Shared workspaces
description: Organize project files and understand what threads share.
---

Each conversation has a persistent working folder and an ordinary-run container with its own home volume. The working folder holds the project's files; the container home retains engine state and CLI logins across turns. Every thread in that conversation uses this workspace.

## Organize a project

Keep one conversation for a project or customer. Ask the agent to use clear folders for inputs and deliverables:

```text
@ChannelGate Read inputs/brief.pdf and create deliverables/project-plan.md.
```

A second thread can review that plan because it sees the same files. It does not automatically receive the first thread's complete engine conversation. Save recurring decisions through [memory](/docs/features/memory) when future threads should recall them.

Open the reply's **Files** control to inspect the actual folder. Read-only mode supports browsing and analysis; creating files and running shell commands normally requires Worker mode or an eligible approval.

## Choose a custom working folder

An operator can configure a conversation's working folder to point at an existing project. Review the effective path and permissions before doing this: the agent will work on those actual files. The container mounts the selected folder; it does not receive the entire host filesystem by default.

Separate folders are recommended for separate conversations. When two conversations share a folder with conflicting managed skill or memory settings, ChannelGate refuses provisioning and asks an administrator to separate the folders or align their settings. It does not silently overwrite another conversation's configuration.

## Understand the boundary

Tool mode and mounted paths are separate controls. Admin mode does not automatically mean host root access. An operator-home grant expands visibility when explicitly configured; Slack `/sudo` is a separate administrator-only choice that runs directly as the daemon's OS user.

For simultaneous repository work, use isolated Git worktrees so threads do not overwrite each other's uncommitted edits. Related: [storage and runtime](/docs/configuration/storage-and-runtime), [files and editor](/docs/features/files-and-editor), and [operations](/docs/operations).
