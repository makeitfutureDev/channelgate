---
title: Runtime lifecycle
description: Understand container reuse, idle stops, persistent volumes, and safe recreation.
---

ChannelGate creates a rootless container for each ordinary conversation. A later turn reuses or starts that container, keeping its work folder and engine state available.

## Persistent state and running work

The conversation work folder is a mount. HOME, `/tmp`, and `/var/tmp` use persistent per-conversation volumes, so stopping or recreating a container does not erase files stored there. Processes and state held only in memory do not survive recreation.

Active turns and supported background/reviewer/SSH/VS Code activity hold leases. The idle reaper avoids stopping a leased environment. The default idle-stop threshold is **10 minutes**, with **8 containers** running at once. When capacity is needed, an eligible idle least-recently-used container can be stopped.

## Configuration and image changes

**Settings → Access & security → Container runtime** controls the CLI, image, lifecycle, and resource limits. Changes to image or container creation settings can require recreation. Compatible busy containers can continue until a safe adoption point; workspace mount changes must wait for conflicting activity rather than silently executing against old paths.

The managed image is verified against the source fingerprint and pinned toolchain. A missing or stale image blocks new runs with an operator remedy such as `npm run build:image`. Selecting a custom image transfers rebuild responsibility to the operator.

## Practical workflow

After changing a conversation's work folder, send a small task that reports its resolved workspace and runtime. Check the actual next-turn facts before assuming the new folder or mounts were adopted. Use System health and the runtime storage report to distinguish running containers from retained volumes.

## Limits

An idle stop is not deletion. Generic prune/reset commands can destroy persistent HOME volumes and must not replace the supported storage workflow. Admin mode changes tool permissions; optional operator-home mounts and `/sudo` host threads are separate decisions.

## Related guides

- [Resource limits](/docs/features/resource-limits)
- [Storage maintenance](/docs/features/storage-maintenance)
- [Container isolation](/docs/features/container-isolation)
