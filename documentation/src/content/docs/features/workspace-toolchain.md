---
title: The workspace toolchain
description: Use the pinned development and media tools installed in every conversation image.
---

The versioned conversation image supplies the tools the agent and authorized developers use. This makes a task reproducible across workspaces and lets operators validate updates centrally.

## What is installed

| Area | Tools and purpose |
| --- | --- |
| Agent engines | Claude Code and Codex CLIs |
| Development | Node, npm, Python, Git, ripgrep, GitHub CLI, common Linux utilities |
| Deployment and data | Vercel CLI, Supabase CLI, PostgreSQL client |
| Browsing | Playwright, Chromium, `agent-browser` |
| Media | FFmpeg, OpenCV, faster-whisper and its video-analysis model |
| Tool transport | MCP helpers and gateway socket/egress helpers |

Exact versions are pinned in the image contract and listed in the [compatibility reference](/docs/compatibility). The OpenCode proof CLI is not shipped by the standard image.

## Ask for a concrete tool check

```text
@ChannelGate Check this workspace's Node, Git, and Supabase CLI versions,
then explain whether they satisfy this project's documented requirements.
```

An installed CLI does not imply a configured account or valid credential. Check the relevant authenticated identity before using a provider, and keep credentials out of logs. Network, shell, file-write, and secret-destination rules still apply.

You can install a project's normal dependencies into its workspace in a writable mode. That is different from replacing gateway-owned engine or media dependencies, which belong in the image build.

## Handle a stale or missing image

The gateway checks the image specification and build digest. A missing or stale runtime image can fail a run before the engine starts. The remedy is an operator image rebuild or the supported update path; the agent should not silently replace pins inside one conversation home.

Conversation home volumes persist across turns and container recreation. The image supplies the base toolchain, while the volume can retain that workspace's dotfiles and CLI logins. Keep those layers separate when diagnosing a version or authentication problem.

Related: [container isolation](/docs/features/container-isolation), [browser automation](/docs/features/browser-automation), [updates](/docs/features/updates), and [interactive CLI access](/docs/features/vscode-access).
