---
title: System health
description: Monitor host CPU, memory, storage, history, and capacity trends in the admin website.
---

**System health** gives administrators a view of the Linux machine running the gateway. It shows CPU, RAM, swap, system load, and the filesystem containing the configured gateway runtime root. These are host-daemon observations, not a measurement of one agent container or a total of every attached disk.

## Open the page

Sign in to the admin website and choose **System health** at the bottom of the navigation. Its route is `/system-health`. Select **Live**, **1h**, **24h**, **7d**, or **30d** to inspect recent behavior.

Collection runs every five seconds even when no browser is open. Pausing the page pauses the display, not background collection. **Refresh** also rescans the hardware inventory.

No conversation setting grants this data to users: the page and metric endpoints require an admin session.

## Read the metrics

CPU is calculated from counter changes; the first sample can be unknown. RAM uses Linux's available-memory figure. Load shows the Linux 1-, 5-, and 15-minute averages.

Storage usage starts warning at **85%**, with a critical level at **95%**. Used and available space follow unprivileged filesystem statistics, so reserved filesystem blocks can explain a difference from raw disk capacity.

For example, compare a high-load period with RAM/swap peaks after a burst of simultaneous builds. Then inspect the active conversations and jobs before changing run concurrency or hardware.

## History and forecasts

Resource minute averages and peaks are retained for 30 days. Storage history is retained for 186 days; older samples are reduced to hourly observations while retaining peaks.

The capacity estimate needs at least seven days of observed history and uses the trend since the last capacity change. “Insufficient history” is expected on a new install. A forecast assumes continued growth; it does not predict future deployments or promise a date when storage will fill.

Hardware is rescanned at startup, every five minutes, and on Refresh. Missing fields remain unknown. The inventory excludes serial numbers, temperatures, MAC addresses, and machine IDs.

Before removing runtime data to free space, follow the storage maintenance runbook. General container pruning can remove persistent HOME volumes or required images.

## Related guides

- [Storage and runtime](/docs/configuration/storage-and-runtime)
- [Background jobs](/docs/features/background-jobs)
- [Admin dashboard](/docs/features/admin-dashboard)
- [Operations reference](/docs/operations#system-health)

- [Resource limits](/docs/features/resource-limits)
- [Storage maintenance](/docs/features/storage-maintenance)
- [Health endpoints](/docs/features/health-endpoints)
