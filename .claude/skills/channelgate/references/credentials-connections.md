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

1. Prefer its documented headless/device authorization mode when available. Start it inside the
   conversation container and relay the exact HTTPS verification link and one-time code to the
   requester. Never claim that ChannelGate opened the browser for them.
2. Keep polling only when the running CLI is designed to wait for device authorization and the
   foreground turn can remain alive. Explain that the link/code is short-lived; do not repeat or
   store it in memory.
3. If the CLI requires a real interactive terminal or loopback browser callback, direct an
   operator to `npm run vscode -- <channel id|slug|name>` and authenticate in the attached live
   container, or use the provider's supported environment token through `/secrets`.
4. Verify with the CLI's identity/status command without printing credential material.

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

