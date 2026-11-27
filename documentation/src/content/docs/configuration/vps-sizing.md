---
title: VPS sizing and hosting
description: Recommended VPS specifications, sizing tiers, concurrency, storage, and backups for a self-hosted ChannelGate gateway.
---

For a typical team deployment, start with **4 dedicated vCPU, 16 GB RAM, and at least 150 GB of persistent SSD/NVMe storage**, running **Ubuntu 24.04 LTS**. Start with four concurrent agent runs and adjust after observing your workload.

These are planning recommendations, not measured capacity guarantees. Browser sessions, builds, background jobs, local transcription, and the number of active conversation containers change the resources you need.

## Recommended production configuration

| Component | Recommendation |
| --- | --- |
| CPU | 4 dedicated vCPU; prefer predictable allocation over heavily oversold shared cores |
| Memory | 16 GB RAM |
| Storage | At least 150 GB persistent SSD/NVMe |
| Operating system | Ubuntu 24.04 LTS, the tested distribution, with systemd |
| Container runtime | Rootless Podman; see [Installation](/docs/installation) |
| Network | Reliable outbound internet; a static public IPv4 is convenient for direct hosting |
| Swap | 4–8 GB as a buffer; size RAM for the active workload |
| Concurrent agent runs | Start with `MAX_CONCURRENT_RUNS=4` |
| Backups | Provider snapshots plus encrypted off-host backups; verify a restore before relying on them |
| GPU | Not required for hosted Claude or Codex inference |

The AI models run at the engine provider. Your VPS runs the gateway, conversation containers, coding tools, browsers, and any local processing you enable. Hosting costs are separate from engine subscriptions or API charges.

## Choose a sizing tier

| Deployment | CPU | RAM | Persistent SSD/NVMe | Starting concurrency |
| --- | --- | --- | --- | --- |
| Pilot or light use | 2 vCPU | 8 GB | 50 GB | 2 |
| Typical production team | 4 dedicated vCPU | 16 GB | 150 GB or more | 4 |
| Busy team | 8 vCPU | 32 GB | 200 GB or more | 6–8 |

A pilot configuration suits a small trial with limited simultaneous work. For production involving browser automation or several active containers, use the 16 GB tier as your starting point. Large builds, many browser sessions, and local transcription can require more RAM or disk even with fewer concurrent runs.

Concurrency counts simultaneous agent runs, including background agent runs, rather than registered users or conversations. Background shell jobs and other processes can consume resources outside that cap.

## Set concurrency and monitor usage

The gateway defaults to **8** concurrent runs. For the recommended 16 GB host, set the startup environment to:

```dotenv
MAX_CONCURRENT_RUNS=4
```

Set this in the gateway's service/startup environment, rather than a conversation's secrets, and restart the service safely. For the pilot tier, start at `2`.

Use [System health](/docs/features/system-health) to watch CPU, memory, swap, and storage during representative busy periods. Reduce concurrency if memory pressure or swapping grows; increase resources before raising concurrency when the host is already constrained. Sustained swap activity is a signal to revisit capacity.

## Choose a hosting provider

Choose a Linux VPS, dedicated server, or physical host that supports **systemd, persistent local storage, and rootless containers**. Check the provider's virtualization and container support before ordering. Dedicated CPU allocation is useful when several conversations run builds or browsers at once.

Compare the complete cost of compute, disk, IPv4, backups, and outbound traffic, as well as the region and support you need. Provider plans and prices change; verify the current offer directly with the provider. A hyperscaler VM can work if it meets the same requirements.

Static hosting and serverless application platforms can host the public website or documentation. The gateway itself needs an always-on Linux host with its own container runtime and durable state.

A public IPv4 is a practical hosting choice, rather than a requirement for Slack Socket Mode. Public HTTPS reachability is needed for Microsoft Teams messaging and externally accessible links or webhooks; see [Deployment configuration](/docs/configuration/deployment) for the relevant integrations and tunnel/proxy options.

## Contabo option

[Contabo](https://contabo.com/) is a budget alternative. Its [current VPS documentation](https://docs.contabo.com/docs/servers-hosting/vps/) lists **Cloud VPS 8: 8 shared vCPU, 24 GB RAM, and 300 GB SSD** (checked 2026-11-03).

This meets our memory and disk starting points, with shared CPU allocation. Start at `MAX_CONCURRENT_RUNS=2` and raise after measuring your workload. Compare Contabo’s Max Performance VPS (VDS) family if you need dedicated cores. These are published specifications; we have not benchmarked ChannelGate on this plan.

Check [Contabo’s current pricing](https://contabo.com/en/pricing/) for your region, contract term, tax, setup fees, and backup add-ons before ordering. Choose Ubuntu 24.04 LTS and follow the same installation and off-host backup guidance as for other providers.

## Plan for storage and recovery

Allow room for runtime images, conversation workspaces and HOME volumes, browser assets, uploaded files, build artifacts, logs, and backups. The disk recommendations are starting capacities; retained project files and media can outgrow them.

Keep off-host backups of the gateway state and the persistent conversation storage you need to recover. Provider snapshots are an additional recovery layer. Follow [Backup and restore](/docs/features/backup-and-restore), [Storage maintenance](/docs/features/storage-maintenance), and the [Operations runbook](/docs/operations) for coverage and restore procedures.

Once the host is ready, follow [Install ChannelGate](/docs/installation) and [Deployment configuration](/docs/configuration/deployment).
