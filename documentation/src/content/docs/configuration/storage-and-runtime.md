---
title: Storage and container runtime
description: Choose runtime limits, workspace locations, and persistent storage for your deployment.
---

The daemon runs on Linux, while ordinary agent turns run inside a separate long-lived container for each conversation. A conversation's working folder, container HOME, and gateway configuration have different purposes and lifetimes.

## Storage locations

| Location | Contents | Default |
| --- | --- | --- |
| Runtime root | Gateway settings, operational database, logs, engine state, automation records | `~/.channelgate` |
| Database | Users, conversations, sessions, skills, approvals, usage, and other operational records | `<runtime root>/gateway.db` |
| Visible workspaces | Project files, instructions, portable conversation memory | `~/ChannelGate/<platform>/<slug>` |
| Conversation HOME volume | CLI logins, engine transcripts, installed user tools, caches | Managed per-conversation container volume |

The paths refer to the daemon account's home, not an arbitrary person logged into the host. Operators can set `CHANNELGATE_DIR`, `CHANNELGATE_DB`, and `CG_WORKSPACE_DIR` in the daemon's startup environment. Plan a storage move using the [Operations](/docs/operations) migration instructions rather than changing a path and expecting the old data to follow.

## Runtime settings

Open **Settings → Access & security → Container runtime**.

| Setting | Default | How to use it |
| --- | --- | --- |
| Container CLI | `auto` | Prefers Podman, otherwise Docker; select one explicitly if needed |
| Image reference | `channelgate/runtime:latest` | Must match a built, compatible runtime image |
| Stop an idle channel container after | 10 minutes | Stops idle containers while retaining storage |
| Max containers running at once | 8 | Reclaims least recently used idle containers beyond the cap |
| Process limit | 1,024 | Limits processes per container |
| Memory limit | Blank | A value such as `2g`; blank adds no container memory limit |
| CPU limit | Blank | A value such as `1.5`; blank adds no container CPU limit |
| Admin channels can access the host home | Off | Deliberately broadens mounts for Admin channels |

## Configure capacity

1. Check **System health** for current CPU, memory, and disk usage.
2. Set practical per-container memory/CPU limits and the number of concurrently running containers.
3. Save. Changes affecting container creation are applied when the next turn resolves its container.
4. Run a representative project task and check resource usage again.

The maximum running-container setting differs from the daemon's concurrent-run limit. An idle container can exist without an agent turn, and several queued turns may wait for run slots.

## Persistence and boundaries

Stopping or recreating a container retains its HOME volume and workspace. Changing a conversation's **Working folder** does not move old files. A missing or stale runtime image fails a new turn closed; the operator remedy is `npm run build:image` from the gateway checkout.

Host-home access exposes the daemon user's home to all admitted members of qualifying Admin conversations, not just admin authors. Non-admin turns become read-only while that home is mounted; they can still read its files. It does not give host root privileges. Use it only when that expanded visibility is intended, and configure it separately from direct-host `/sudo` threads.

See [System health](/docs/features/system-health), [Shared workspaces](/docs/features/shared-workspaces), [Backup and restore](/docs/features/backup-and-restore), and [Container isolation](/docs/features/container-isolation).
