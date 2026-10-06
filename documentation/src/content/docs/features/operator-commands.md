---
title: Operator commands
description: Find the supported installation, image, backup, accounting, and maintenance workflows.
---

These commands run from the **gateway source checkout**, as its configured OS account. They are operator workflows rather than ordinary chat-container tasks.

## Installation and service

| Command | Purpose |
| --- | --- |
| `npm run setup` | Interactive installation setup |
| `npm start` | Start the daemon in the foreground |
| `npm run service:install` | Install the systemd service |
| `npm run service:uninstall` | Uninstall that service |
| `npm run update` | Host-managed transactional update |
| `npm run build:image` | Build the managed container image |

Read [installation](/docs/installation) and [operations](/docs/operations) for prerequisites, service permissions, and exact deployment setup. ChannelGate requires Linux and Node 22.13 or newer; ordinary engine turns need the supported container runtime/image.

## Data and capacity

| Command | Purpose and write behavior |
| --- | --- |
| `npm run backup` | Encrypted configuration backup |
| `npm run restore` | Restore selected backup data; changes state |
| `npm run restore:drill` | Validate restoration in a temporary test location |
| `npm run runtime:storage` | Report only; `-- --apply` requests eligible reclaim |
| `npm run maintenance` | Mutating backup/log retention maintenance |
| `npm run usage:repair` | Dry-run accounting repair; `-- --apply` installs plan |
| `npm run usage:reprice` | Dry-run pricing refresh; `-- --apply` installs plan |
| `npm run usage:external` | Scan supported local non-gateway usage |

Additional supported workflows include `npm run vscode -- <conversation>` for the conversation development environment, `npm run whisper:install` for local transcription dependencies, and `npm run vpn` for the operator VPN service workflow. Read each guide before applying a setup change.

## Example

When a run reports a stale runtime image, confirm the daemon checkout, run `npm run build:image`, inspect the build result, then verify a small turn. Building inside an unrelated conversation folder does not update the host daemon's managed image.

## Related guides

- [Storage maintenance](/docs/features/storage-maintenance)
- [Pricing and usage repair](/docs/features/pricing-and-usage-repair)
- [VPN and database access](/docs/features/vpn-database)

`npm run usage:external` is a dry-run report by default. `npm run usage:external -- --apply` records eligible external usage; review the scan before applying it.
