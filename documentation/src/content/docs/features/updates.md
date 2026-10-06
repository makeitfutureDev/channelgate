---
title: Updates and rollback
description: Update the gateway and runtime image, monitor transaction progress, and recover a failed candidate.
---

ChannelGate's updater treats an upgrade as a transaction: inspect prerequisites, preserve recovery data, install the candidate, restart, and verify the daemon. A failed candidate can return to the previous revision rather than leaving a partly upgraded installation.

## Choose the update path

Every operator can run the host-managed updater from the gateway checkout:

```sh
npm run update
```

Entitled Enterprise installations also expose managed Update controls in the admin website and through authorized chat requests. Managed update requests are admin-only. Other editions can inspect their behind count and use the host command.

Use the deployment's configured branch. Stable installations follow `main`; beta installations intentionally follow `beta`. A documentation change or development task does not authorize promoting beta into stable.

## Prepare and observe

Before a material upgrade, create an encrypted backup and test the restore drill. Check disk capacity, current work, and service health. Keep recovery files until the updated installation has been verified.

Only one update transaction can run at a time. A second request reports the existing transaction. The updater checks Git safety and disk space, snapshots the revision/dependencies/configuration, installs exact dependencies, runs security and regression checks, provisions configuration, checks the runtime image, restarts, and verifies authenticated readiness.

The admin interface reports progress and the final result. Check for **updated**, **rolled back**, or an explicit failure; a restart by itself is not proof that the update completed.

## Runtime image updates

The container image is compared against the desired source fingerprint and pinned CLI versions, even if the checkout revision has not changed. Active work keeps its container until image adoption is safe.

An image build failure remains visible and is retried by a later Update. The daemon update can succeed with an image warning while future agent starts remain blocked by the stale image. Follow the stated remedy:

```sh
npm run build:image
```

Custom image references are operator-managed and are not silently replaced with the default image.

## Recovery

A candidate failure triggers the documented rollback path for code and dependencies. Runtime database snapshots are not silently restored, because doing so could erase work recorded during the transaction. Inspect the result and verify chat, enabled engines, permissions, and your workflows after recovery.

## Related guides

- [Backup and restore](/docs/features/backup-and-restore)
- [Container isolation](/docs/features/container-isolation)
- [System health](/docs/features/system-health)
- [Operations reference](/docs/operations)

- [Restart and recovery](/docs/features/restart-and-recovery)
- [Runtime lifecycle](/docs/features/runtime-lifecycle)
