---
title: Restart and recovery
description: Drain current work safely and understand which interrupted operations can resume.
---

A safe restart waits for ongoing work rather than immediately interrupting it. It checks foreground/queued engine activity, background jobs, API runs, and active update transactions.

## Request a safe restart

Administrators use **Settings → System** or ask for a restart in chat. The chat control lets the requesting turn finish, then checks every **30 seconds** for up to **five minutes**. It restarts only after work is idle; if work remains, it cancels and reports the reason.

A chat request requires an explicit approval outside Admin mode. The admin website also supports an explicitly forced restart; force interrupts ongoing work and should be a deliberate recovery choice.

## What survives

Conversation work folders, persistent container volumes, memory, sessions, schedules, and durable approvals remain stored. The daemon can recover supported interrupted interactive turns and queued transport events after boot. Process memory and unsupported in-process work do not survive.

A stopped interactive request can be carried once into the next message in its thread so the agent understands what you are continuing. The new user message remains authoritative.

## Automation recovery

The scheduler saves completed results before delivery. A pending delivery can resend that result rather than rerun the task. A schedule found interrupted during execution can be disabled with an explicit status because its external actions are unknown.

Beta transport intake is durable: accepted means queued in SQLite, not completed. Queued events can resume; running events must not blindly repeat unknown tool effects.

## Verify the restart

Check health, connection state, and the reported result. An authenticated health response includes process identity and revision so the UI can distinguish a real new daemon process. Resume or re-enable interrupted work only after checking its effects.

## Related guides

- [Health endpoints](/docs/features/health-endpoints)
- [Updates and rollback](/docs/features/updates)
- [Conversation controls](/docs/controls/conversation-settings)
