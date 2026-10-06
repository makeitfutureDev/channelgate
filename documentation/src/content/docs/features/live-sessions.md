---
title: Live sessions
description: See which conversations, people, engines, and models are running right now.
---

The **Overview** page includes an **Active sessions** count. Open it to see the turns currently being processed, with conversation, author, engine, model, and elapsed running time.

## Inspect current work

Use the engine filter on Overview to narrow the live count and list. This filter is independent of historical reporting ranges: an active turn is current even when its eventual usage row has not yet been written.

The web interface maintains an authenticated event stream. Each update is a complete snapshot; reconnecting repairs missed updates. A REST read is available as a fallback. The modal updates elapsed time while open and refreshes state when opened.

For example, before a planned restart, open Active sessions and identify the conversation with ongoing work. Coordinate in that conversation or use the safe restart workflow to wait for work to drain.

## What the list means

The active-run records contain runtime status and are cleared when turns finish. The admin response deliberately omits prompt text. A live row does not mean the engine is currently producing an answer: it may be waiting for a tool or approval.

The list is read only; it is not a universal job cancellation console. Use the conversation's controls for foreground turn interruption and the relevant automation/job workflow for durable background work.

## Recovery and access

Only an authenticated admin web session can read the live-session API or event stream. Durable active-run records help the daemon recover interrupted interactive turns after restart, but recovery cannot roll back actions already performed in an external service.

## Related guides

- [Admin dashboard](/docs/features/admin-dashboard)
- [Activity and audit](/docs/features/activity-and-audit)
- [Restart and recovery](/docs/features/restart-and-recovery)
