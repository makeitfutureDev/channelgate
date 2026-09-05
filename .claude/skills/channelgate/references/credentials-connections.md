# Credentials and CLI connections

## Keep the three credential classes separate

1. **Per-channel environment secrets** are provider tokens injected on every spawn.
2. **Saved CLI sessions** live in the conversation's durable `/home/agent` volume.
3. **Engine credentials** let the gateway start Claude or Codex and follow engine-specific rules.

Do not copy credentials between these classes or silently fall back to an unrelated account.

## Environment secrets (`/secrets`)

A conversation can own credentials such as `VERCEL_TOKEN`, `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_PASSWORD`, or `MAKE_API_TOKEN`. A permitted human adds/replaces/removes them with
Slack `/secrets`, the reply's key control, or the Admin UI. The agent has no setter by design.

Every listing returns only name, provider, last four characters, and audit metadata. Values have no
reveal route, even for admins. They are filtered against dangerous/reserved environment names both
when stored and immediately before engine spawn, applied with reviewed precedence, and redacted
from streamed/final replies and background output. A rotation retires the affected warm engine
process; it does not recreate the container. Ask the human to enter a named variable through
`/secrets`; never ask them to paste its value into chat or a repository file.

## Saved CLI sessions and device login

The image ships the supported toolchain, while installs under `~/.npm-global`, `~/.local`, pipx,
uv, cargo, bun, deno, and Go persist in the channel HOME. A login performed there belongs only to
that conversation and survives idle stop, image recreation, daemon restart, and rollback.

When a CLI reports that it is not authenticated:

1. Prefer its documented headless/device authorization mode when available. Inspect credential
   source precedence without displaying values: an injected provider token can override a saved
   CLI login. For a fresh device login, omit only conflicting provider-token variables from the
   login and verification subprocesses; do not unset them globally or delete unrelated secrets.
2. Start the command in a real TTY/session and advance any “open browser” prompt until the CLI is
   actually waiting. Relay the exact HTTPS verification link and one-time code as an interim
   commentary update, never as the final response. Browser-open failure inside a headless container
   is expected. Never claim that ChannelGate opened the browser for the requester.
3. Keep the SAME assistant turn and CLI session alive, polling at intervals no longer than 60
   seconds. A final response ends the turn and may discard the waiting process. Treat “done” as an
   update to the active wait, and finish only after the CLI itself confirms authentication.
4. If the process/session vanished or the code expired before CLI confirmation, start a fresh flow
   and send its NEW code. Never reuse the old code or infer success from the browser page alone.
5. Verify with the CLI's non-secret identity/status command under the same environment precedence;
   if a target account/repository matters, verify that access too without printing credentials.
6. If the CLI requires a real interactive terminal or loopback browser callback, direct an
   operator to `npm run vscode -- <channel id|slug|name>` and authenticate in the attached live
   container, or use the provider's supported environment token through `/secrets`.

Do not move an interactive device-code wait to a daemon background job: the requester needs its
short-lived code in this conversation and the foreground turn must retain the session.

Do not tell the host operator to log in globally for an ordinary provider CLI: that would create
the wrong identity and the container cannot see the host login anyway.

## Claude and Codex authentication

Claude login resolution has one owner. Order: configured `claude setup-token`, the operator's own
Claude login, a gateway engine-home login, then `ANTHROPIC_API_KEY`; otherwise fail closed with the
named host-side remedy. The operator credential file is never copied, linked, or mounted. A run
receives a relay of the current access token as `CLAUDE_CODE_OAUTH_TOKEN`, refreshed in the source
config directory. A channel secret cannot override it.

Codex reads and rewrites `auth.json` in place, so the container receives the gateway's real auth
file through its narrow credential mount rather than a copy. Its session/history state remains in
the conversation HOME. Use `/status` or host-side engine health to diagnose these shared engine
credentials; a conversation cannot repair them through `/secrets`.

VS Code attachment opens the existing live container/workdir and holds an editor lease. It sees
the same channel HOME and provider CLI sessions. Claude gets the access-token relay wrapper; Codex
keeps its narrow auth mount. Channel environment secrets are deliberately not injected into the
editor session.
