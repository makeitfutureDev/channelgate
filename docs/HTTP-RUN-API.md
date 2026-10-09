# HTTP run API conversations

Authenticate `POST /api/runs` with `X-API-Key` or `Authorization: Bearer` using the run API key
generated in Settings. An authenticated admin session also works. The Admin UI's HTTP run API
page documents message/file inputs, engine overrides, polling, stopping and completion webhooks.

To keep separate events from an external conversation in the same Slack thread:

```json
{
  "channel": "C0123456789",
  "conversationKey": "mail:thread:external-thread-42",
  "idempotencyKey": "mail:event:external-message-57",
  "message": "Summarize this new message and use the conversation context."
}
```

`conversationKey` is an optional, case-sensitive, nonblank string of at most 200 characters,
without control characters. Keys are preserved exactly. Supply a registered Slack channel ID,
slug or name; all aliases resolve to the same canonical channel ID. Identical keys in different
channels create independent threads. A key cannot name a timestamp or select another channel's
thread. The mapping survives restarts and the seven-day run-history cleanup.

The first accepted event creates a root containing its request. Later events add their requests
and answers as replies to that root. Each event gets its own job and enters the same thread queue
used by interactive Slack messages. The agent session is resolved after acquiring that queue,
so a later event continues the existing session. Normal engine changes, `/clear`, and runtime
lane separation still apply; a conversation key does not grant access to another runtime lane.

POST returns 202 for a new job, including events reusing an existing thread. A duplicate
`idempotencyKey` within the existing 15-minute window returns 200 and the original job with
`reused:true`. Use a unique event key across callers; assigning a previously used event key to
another keyed conversation or channel returns 409. This deduplication window is separate from
the persistent conversation mapping.

POST, GET status/list and completion webhooks expose:

- `conversationKey`: the external key, or null when omitted.
- `threadTs`: Slack root timestamp, or null for a headless run.
- `threadReused`: whether this event used an existing root. An idempotent retry preserves the
  original event's value; `reused` separately indicates whether POST deduplicated the job.
- `threadPermalink`: Slack's link to that root, or null if no thread or link lookup failed.

For keyed jobs, `sessionId` and `resumeCommand` are null in the initial response. Poll
`statusUrl` until completion for the actual engine session and container resume command.
Queued events report `status:queued`; they run after the preceding thread turn finishes.

On reuse the bot checks only the mapped root's exact timestamp using `conversations.history`.
It needs the matching history scope and channel membership. If the root was deleted or is no
longer returned, the API creates one replacement and updates the mapping; the replacement begins
a fresh agent thread. Channel access failures, missing scopes, throttling and transport errors
return 503 without starting the agent, creating a duplicate root or falling back to headless.
A failed permalink lookup does not prevent a run; later events retry the lookup if needed.
Slack root creation and SQLite writes cannot form one distributed transaction: if the daemon
dies after Slack accepts a root but before the binding is saved, an orphan root can remain.

Omitting `conversationKey` preserves the previous behavior: independent threads for channel
runs, with a headless fallback when Slack is unavailable, or the synthetic API workspace when
`channel` is omitted.
