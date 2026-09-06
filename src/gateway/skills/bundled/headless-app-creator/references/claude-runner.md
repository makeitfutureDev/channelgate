# Runner contract

Read `src/engines/claude.js`, `persistent-session.js`, `session-pool.js`, `watchdog.js` and
`src/gateway/run.js` for the current implementation. Reuse their helpers rather than copying a
standalone example that can drift from container execution and authorization.

- Build argument arrays without a shell. Claude stream output uses `--output-format stream-json`,
  `--verbose` and the appropriate partial-message support. A new session and a resumed session
  have different CLI arguments; use the adapter's session contract and persist the actual identity.
- Resolve a runtime target for each spawn, including jobs and memory reviewers. Container mounts
  establish confinement; folder settings establish tool policy. The admin bypass requires an
  admin author and an admin-mode channel. Requested run overrides can only reduce stored policy.
- Resolve credentials through their declared provider module. Do not copy or relay operator
  subscription refresh credentials into a channel. Keep channel-native logins in its own HOME.
- Pass curated environment variables. Filter reserved variable names at the runner boundary,
  apply gateway-owned identity last, redact values from output and retire warm processes when
  credentials or permissions change.
- Every runner uses `createStallWatchdog`. Inactivity triggers a process probe and a visible wait
  update; it is not an execution-duration limit. Stdout activity resets silence, stderr chatter
  does not. Respect explicit stop and the configured absolute silence budget.
- A warm process is reusable only when its complete identity/permission/runtime fingerprint
  matches. An author change must not reuse another author's personal MCP identity.
- A thread explicitly pinned to an engine/model never silently fails over. Otherwise fallback is
  limited to classified replay-safe failures before tools have run. An interrupted run with an
  unknown side-effect outcome requires reconciliation, not blind prompt replay.
- Drain and classify subprocess output on exit; preserve bounded diagnostics and distinguish
  authentication, provider limit, network, cancellation, silence and process-loss failures.
