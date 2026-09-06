---
name: headless-app-creator
description: Maintain ChannelGate's Linux headless engine runners, persistent sessions and NDJSON streaming. Use for subprocess lifecycle, session recovery or streaming changes in this repository.
---

# ChannelGate headless runners

Use the shipped runner and runtime contracts as the source of truth. This bundled skill covers
ChannelGate; it does not scaffold unrelated web, Swift or desktop products.

1. Read the affected engine adapter, runner and focused regression tests. Engine facts belong in
   `src/engines/registry.js`; per-platform facts belong in `src/platforms/`.
2. Resolve the channel runtime at the actual spawn boundary. Every foreground/background engine
   and memory reviewer runs inside its channel container, with its declared mounts and credentials.
   Do not add direct host engine spawning to a conversation path.
3. Preserve authorization, credential scoping, engine pins and the shared stall watchdog. Make
   durable execution state distinct from delivery state; an unknown interrupted mutation must not
   be replayed as a fresh prompt automatically.
4. Verify behavior using the existing fake subprocess/connector fixtures, then document applicable
   live Claude and Codex acceptance separately. Do not label a mocked run as live acceptance.

For argument/session and process lifecycle changes, read [runner contract](references/claude-runner.md).
For line buffering, event normalization and delivery changes, read [streaming contract](references/streaming.md).
