---
title: Backup and restore
description: Create encrypted gateway-state backups, verify restores, and preserve workspace data separately.
---

ChannelGate provides an encrypted backup of its durable gateway state. It includes the database, settings, connector configuration, conversation metadata, schedule records, and other operational state. Treat a backup as sensitive because it can contain credentials even though the archive is encrypted.

## Make a backup

Run from the operator's gateway checkout:

```sh
npm run backup
```

The command makes a transactionally consistent SQLite snapshot and encrypts the archive with AES-256-CBC/PBKDF2. It writes dated backups and a current `config.tar.gz.enc` under the runtime root's `backups/` directory, outside the repository.

Provide `CG_BACKUP_PASSPHRASE` or `CG_BACKUP_KEY_FILE` for unattended use. Without either, the script generates a local `.backup-key` once. You cannot restore without the corresponding key/passphrase. Keep the encrypted blob and its key in separate protected locations off the machine.

## Check what is covered

The backup covers `gateway.db`, managed `config/`, and durable channel metadata under the runtime root. It **does not** back up the visible project workspaces or each container's persistent HOME volume.

Push project repositories to their intended remotes and back up uncommitted files, standalone documents, channel memory files, and other workspace data separately. Plan separate preservation of container-local state when it is required. A successful gateway backup is not proof that every project file is recoverable.

## Verify before an emergency

After material upgrades and at least monthly, run:

```sh
npm run restore:drill
```

The drill restores into a disposable location and runs SQLite integrity checks. It does not replace the live installation. Retain its result and check that the key used for the drill is the key your recovery process actually preserves.

## Restore deliberately

Stop the daemon before a real restore, then use:

```sh
npm run restore
```

Interactive restore requires typing `RESTORE`. Unattended restore also requires `CG_RESTORE_CONFIRM=YES`. Follow the operator runbook to select the intended archive and key.

Restore replaces the managed config and channel-metadata directories rather than merging stale files into them. Restoring an older database also restores older counters and verification state. Start the daemon afterward and verify connections, schedules, license status, and a representative task.

## Related guides

- [Storage and runtime](/docs/configuration/storage-and-runtime)
- [Updates](/docs/features/updates)
- [Shared workspaces](/docs/features/shared-workspaces)
- [Operations reference](/docs/operations#backup-and-restore)
