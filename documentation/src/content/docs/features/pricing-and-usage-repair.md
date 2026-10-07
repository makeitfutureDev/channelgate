---
title: Pricing and usage repair
description: Preview accounting repairs, preserve raw evidence, and audit API-equivalent cost estimates.
---

ChannelGate's usage ledger preserves run evidence and separates canonical accounting components from that evidence. Historical repair reconstructs supported Codex usage where older records lacked complete parent/child accounting.

## Inspect before applying

Run these from the gateway checkout as the daemon's OS account:

```sh
npm run usage:repair
npm run usage:reprice
```

Both commands are **dry run by default**. Repair reports matched and unmatched evidence; repricing reports the affected historical window. Applying with `-- --apply` creates a consistent database backup and installs the computed plan in a bounded transaction. Original run/raw-evidence rows remain available.

Upgraded daemon boot can perform the same idempotent legacy repair and pricing refresh when eligible records exist. A manual preview remains useful for checking historical cutoffs and unmatched sessions.

## Pricing basis

Administrators can inspect per-model rates in **Settings → Agent defaults**. Dashboard cost is an API-equivalent estimate derived from token evidence and the applicable pricing basis, including supported cache accounting. It is not necessarily a subscription invoice or a provider's billed amount.

A repair needs the corresponding local Codex rollout evidence. Missing transcripts, uncertain attribution, or unpriced models cannot be replaced with invented token totals. Re-run a provider-rate audit when model pricing changes.

## Outside-gateway usage

The **Overview** source filter can separate gateway-driven usage from local engine usage the gateway did not launch. The external scanner reads supported transcripts/rollouts, excludes recognized gateway sessions, and reports scan freshness and errors. `npm run usage:external` is the operator scan command. Client-origin labels reflect recorded evidence rather than a guess about who was at the keyboard.

## Related guides

- [Usage and costs](/docs/features/usage-and-costs)
- [Activity and audit](/docs/features/activity-and-audit)
- [Backup and restore](/docs/features/backup-and-restore)

`npm run usage:external` is a dry-run report by default. `npm run usage:external -- --apply` records eligible external usage; review the scan before applying it.
