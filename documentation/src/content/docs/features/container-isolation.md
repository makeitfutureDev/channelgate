---
title: Container isolation
description: Understand the per-conversation container, persistent workspace, runtime lifecycle, and optional mounts.
---

Each ordinary ChannelGate conversation runs inside its own rootless container. A Slack channel, a DM, a Teams conversation, and a Google Chat space have separate workspaces and persistent HOME volumes unless an operator explicitly configures shared folders.

This boundary applies to foreground tasks, scheduled runs, background agents, and normal background shell work. You can give a development channel useful tools without exposing the gateway's process namespace or every file on the machine.

## What persists

The visible workspace holds project files and channel memory. The container's persistent HOME holds engine sessions, user-installed tools, and CLI state. Stopping or recreating the container preserves that HOME volume.

A container may idle-stop when it has no live work. Foreground runs, background work, memory review, and SSH sessions keep it leased. A later task starts the container again. An image or runtime change can recreate it when safe; a missing or outdated runtime image fails closed and gives the operator a rebuild remedy.

## Operator configuration

Open **Settings → Container runtime** to inspect the runtime configuration. Build the supported image from the gateway checkout when required:

```sh
npm run build:image
```

The image ships reviewed engine and development tools. Its system toolchain is root-owned; an agent cannot replace its engines or use host package installation. Add missing system packages to the image through the operator's normal change/rebuild process. Project dependencies and ordinary user tools can live in the channel workspace or HOME.

## Boundaries and exceptions

The default container sees its workspace, generated run artifacts, and required gateway control/proxy sockets. It does not see the gateway database or other conversations' directories.

An operator can enable **Admin channels can access the host home**. For an eligible Admin channel this exposes the operator home to all admitted members; non-admin turns become read-only. It remains a container, and this is broader access than the default.

An admin-only Slack `/sudo` thread is a separate direct-host feature. Inspect the run's access facts instead of treating Admin mode, a home mount, and host execution as interchangeable.

Do not use general container pruning to reclaim space: it can delete persistent channel HOME volumes. Follow the operator maintenance guidance.

## Related guides

- [Shared workspaces](/docs/features/shared-workspaces)
- [Storage and runtime](/docs/configuration/storage-and-runtime)
- [SSH access](/docs/features/ssh-access)
- [Sudo threads](/docs/features/sudo-threads)
