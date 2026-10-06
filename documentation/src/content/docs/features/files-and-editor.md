---
title: Files and browser editor
description: Browse, edit, upload, and share files from the conversation workspace.
---

The Slack file explorer lets you inspect the conversation's working folder without asking the model to list files. Open **Files** from a bot reply or the **Browse channel files** message shortcut. A reply naming an existing file can also provide a direct file button.

## Review and edit a deliverable

Ask for a concrete file, then open it from the reply:

```text
@ChannelGate Create reports/customer-summary.md with the decisions from this thread.
```

The explorer provides folder navigation, metadata, and bounded text previews. A truncated preview does not mean the underlying file is truncated. In writable modes, **New file**, **New folder**, and **Edit** appear for eligible paths. The native Slack editor handles text up to 3,000 characters.

With the gateway's **Public URL** configured, **Edit in browser** opens eligible UTF-8 text files up to 250,000 characters and 1 MB. Markdown gets a live preview. Saving checks the file's original content hash; if someone else changed it, reopen the file instead of overwriting their changes.

## Upload or share files

**Upload files / folder** uses the public gateway URL to transfer files directly into the workspace. It supports up to 200 files and 250 MB total, preserves nested paths, and refuses name collisions. Browser folder pickers do not preserve empty folders.

**Share** copies a file up to 25 MB into the originating Slack conversation or thread. **Send to me** sends it through the bot privately. A browser **Download** link can stream a larger file directly from the gateway.

## Access and expiry

Read-only mode hides write controls. Managed, credential, key, binary, and other protected paths remain ineligible for editing. Every action rechecks authorization, membership, and path containment. Browser editor links are single use for ten minutes, then establish a one-hour session for that file; a daemon restart invalidates open sessions.

Related: [attachments and voice](/docs/features/attachments-and-voice), [shared workspaces](/docs/features/shared-workspaces), and [deployment settings](/docs/configuration/deployment).
