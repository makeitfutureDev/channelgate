---
title: Health endpoints
description: Monitor daemon liveness without exposing authenticated engine and host details.
---

`GET /api/health` reports whether the daemon is answering. Its response depends on caller authentication.

## Public liveness

An unauthenticated caller receives `ok`, a process `instanceId`, and safe Slack connection state (`status` and `connected`). It does not receive the gateway path, workspace identity, authentication configuration, detailed errors, or engine login information.

For a local operator check:

```sh
curl --fail http://localhost:4747/api/health
```

Use the configured host and port. A successful response with `connected: false` means the daemon answered but Slack is not connected; do not treat those as the same health state.

## Authenticated readiness

An admin session receives revision, sanitized update state, engine health and enablement, warm sessions, dropped-write counters, full platform snapshot where exposed, and container-runtime status. The detached updater can obtain readiness through a narrower same-machine authenticated path; that does not make detailed health public.

`instanceId` changes with the daemon process, allowing the UI to detect a restart even if it occurs between two successful polls. `droppedWrites` can reveal best-effort accounting/event persistence failures that otherwise make totals incomplete.

## Network and security

Health still follows the deployment's Host/Origin guard. Configure **Settings → Connection → Public URL** for the trusted reachable origin when using a tunnel or reverse proxy. Public URL does not open a port or create a tunnel. The HTTP run API token is not a general admin credential and does not authorize all detailed health/admin reads.

## Limits

Liveness alone does not prove chat admission, a model entitlement, connector authentication, or successful engine execution. Test the applicable workflow separately. Beta platforms have their own connection and delivery state; public Slack health is not a universal transport report.

## Related guides

- [Authentication health](/docs/features/authentication-health)
- [Restart and recovery](/docs/features/restart-and-recovery)
- [System health](/docs/features/system-health)
