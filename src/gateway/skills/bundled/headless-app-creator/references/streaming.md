# Streaming contract

Use `src/engines/stream.js` and the engine runners for input normalization; use
`src/platforms/format/` and the transport delivery helpers for output. Public UI code consumes
normalized events, not a provider-specific stream invented by each route.

- Buffer incomplete NDJSON lines across chunks and flush a trailing line on close. Handle UTF-8
  chunk boundaries and malformed diagnostic lines without losing the final result.
- Distinguish assistant deltas, tool activity, usage and terminal results. Apply secret redaction
  before publishing text, job output or live events. Engine stderr is diagnostic commentary and
  does not prove forward progress.
- Show queued position, running activity and a ticking heartbeat during long turns. Every new wait
  state needs a visible explanation; progress delivery must not itself kill a healthy engine.
- Respect declared platform edit budgets, threading and formatting capabilities. Automation
  delivery resolves the destination connector even when Slack is disconnected.
- Persist completed output before attempting its external delivery. Retrying delivery must not
  rerun the model or its tools. Unknown execution outcomes after restart are surfaced for explicit
  reconciliation. Remote delivery acknowledgments can still be lost; document at-least-once
  delivery where the provider lacks an idempotency key.
- Test split lines/characters, malformed events, final flush, cancellation, quiet-but-live turns,
  disconnected destinations and crash/restart boundaries with controlled fixtures.
