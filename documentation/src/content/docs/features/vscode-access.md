---
title: VS Code and interactive CLI access
description: Open the actual conversation container with VS Code or a terminal and continue development there.
---

Developers can work inside the same container and workspace as the chat agent. This preserves project files, the conversation home volume, and available CLI state instead of creating a look-alike development container.

## Connect from your laptop

Use the [SSH setup](/docs/features/ssh-access): register your own public key, obtain a conversation grant, and ask for the connection block. Add it to your laptop's SSH configuration, then connect through **VS Code Remote-SSH**. Open the working folder shown by the gateway.

```text
Show the SSH connection details for this conversation and the VS Code open command.
```

The broker admits only an approved authorized person with a registered key and conversation grant. SSH is refused when the applicable operator-home mount policy would expose the operator's home. A full shell inside the shared container is more authority than a read-only agent turn.

## Operator-side Dev Containers access

An operator working at the gateway host can run:

```bash
npm run vscode -- <conversation-id-or-slug>
```

The helper opens the existing conversation container through VS Code Dev Containers and holds an editor lease so the idle reaper does not stop the container while the window is open. It refreshes the applicable engine credential relay for the lease lifetime. Closing the window releases the lease and removes the temporary live relay material.

## Run the CLIs inside the workspace

Interactive `claude` and `codex` use the conversation's gateway wrappers and policy rather than an unrelated laptop login. They can receive selected tools, connections, and permitted environment secrets. A terminal has no originating Slack thread for approval or background cards; those foreground chat controls are not universally available there.

Use the returned `/resume` command to continue an eligible chat session, or adopt an eligible local session back into Slack. Set your Git identity per session and coordinate concurrent edits: every developer in this container shares its operating-system user and workspace.

Related: [session handoff](/docs/features/session-recovery), [workspace conflicts](/docs/features/shared-folder-conflicts), [toolchain](/docs/features/workspace-toolchain), and [SSH control reference](/docs/controls/ssh).
