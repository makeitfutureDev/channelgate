---
title: Storage maintenance
description: Report reclaimable container storage and maintain runtime backups and logs deliberately.
---

Persistent conversation state occupies work folders, the gateway runtime root, and rootless container storage. Use the supplied reports before deleting anything.

## Container storage report

From the gateway checkout, as the daemon's OS user:

```sh
npm run runtime:storage
npm run runtime:storage -- --json
```

This is **report only by default**. It identifies supported reclaim candidates while preserving running gateway containers, conversation HOME volumes, the current image, the retained rollback image, and another live installation's state. The default keeps **one previous image** for rollback.

Only an explicit `-- --apply` requests removal of items the report marks removable. The gateway does not automatically reclaim container storage. Avoid generic `podman system prune`, reset, volume prune, or Docker equivalents: they can delete the very volumes that preserve engine sessions and CLI logins.

## Runtime file maintenance

`npm run maintenance` is a separate **mutating** operator command. It removes eligible old encrypted configuration archives and update backup entries, and copy-truncates oversized logs. Defaults are **30 days** retention and **10 MiB** maximum log size, configurable through `CG_RETENTION_DAYS` and `CG_MAX_LOG_BYTES`.

It is not a dry run and is not a SQLite compaction command. Review backup retention before invoking or scheduling it. Copy-truncate can lose log writes in the brief rotation window.

## Practical workflow

Use **System health** to spot a storage trend, run the storage report, retain recovery evidence, and then apply only the reviewed reclaim plan. Confirm freed capacity and a small engine turn afterward.

## Related guides

- [Runtime lifecycle](/docs/features/runtime-lifecycle)
- [Backup and restore](/docs/features/backup-and-restore)
- [Operator commands](/docs/features/operator-commands)
