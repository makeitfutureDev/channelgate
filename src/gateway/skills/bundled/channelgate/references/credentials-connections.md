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

Write-only is the listing/reveal contract, not a claim that a spawned process cannot read its
environment. When injected, these credentials are usable by the channel's process and CLI;
verify availability with non-secret status checks and never print values.

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

Claude daemon authentication uses supported organization API credentials resolved in
`src/gateway/claude-login.js`: `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. Operator subscription
files and legacy setup-token settings are not relayed. If missing, name the service-environment
remedy rather than attempting to copy host credentials or create a second refresh chain.

Codex uses the daemon's `CODEX_API_KEY` (before `OPENAI_API_KEY`), or an independent native login
in that channel's persistent HOME. There is no shared writable host `auth.json` mount. A native
channel login may be unknown to daemon health until the engine runs; a failure in one channel
must not mark every other channel's login unusable.

VS Code attaches to the existing channel container/workdir and holds an editor lease in daemon
metadata. It sees that channel's existing native CLI sessions, but no daemon auth or channel
secret environment is exported into the editor. Authenticate natively in the attached terminal.
