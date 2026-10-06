---
title: Settings search and conflicts
description: Find settings quickly and handle concurrent edits without overwriting unrelated changes.
---

The **Settings** page has a search box and section navigation for Connection, Agent defaults, Access Templates, Integrations, License, Access & security, and System. Search filters the rendered settings; clear it to restore the full form.

## Find a control

For example, search “container” to find runtime settings, or “schedule” to find interval and count limits. Matching is case insensitive and supports multiple terms. Search is a navigation aid, not a secret lookup or a query across every gateway record. On Settings, `/` or **Ctrl/⌘ K** focuses search; Escape clears it. Filtering preserves unsaved field values rather than resetting the form.

Use the global Save action after editing. Model selectors preserve a configured value that is absent from the refreshed catalog rather than silently replacing it. Blank token/password fields generally mean keep the current credential; use explicit clear controls to remove it.

## Concurrent saves

The browser tracks the settings snapshot it loaded and sends only changed values. The server merges that patch, so an untouched setting is not reasserted from an old browser tab. A version check rejects a stale save rather than silently accepting a conflict.

When a conflict appears, inspect the returned current settings, reload/reconcile the intended changes, and save again. Do not repeatedly submit an old full-form snapshot. Password changes can require signing in again before retrying.

## Conversation file edits

Conversation instructions have a separate file-hash check. If the file changed after loading, the server returns a conflict and tells you to reload and re-apply your edit. This can occur when an agent and a human editor work on instructions simultaneously.

## Authority and limits

Search is local to the authenticated admin interface. Saving settings is a gateway-wide change; use conversation settings for a local override. A saved setting can have a next-turn, next-container, or restart requirement depending on the field. Read its status and verify the applicable runtime.

## Related guides

- [Gateway settings](/docs/configuration/gateway-settings)
- [Conversation administration](/docs/features/conversation-administration)
- [Restart and recovery](/docs/features/restart-and-recovery)
