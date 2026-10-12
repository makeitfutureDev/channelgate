# Perplexity research delegation

ChannelGate can give Claude and Codex an optional Perplexity researcher using one shared
subscription account. Ask the current agent to delegate a public-source research question; it
receives the researcher's answer and citations and then replies in the same conversation.
The selected coding engine and its model stay unchanged.

## Connect the subscription

1. Install the upstream login client on a trusted machine:

   ```sh
   uv tool install perplexity-web-mcp-cli==0.16.1
   pwm login
   ```

2. Complete its email login, then obtain the saved token from
   `~/.config/perplexity-web-mcp/token`. Treat its contents as a password. Transfer it directly
   into the admin UI; do not paste it into chat, repository files or test evidence.
3. Open gateway **Settings → Perplexity research**, paste the session token, enable research
   delegation and save. Enable the conversation's network access and turn Lean off.
4. Build the updated runtime image with `npm run build:image` before starting a new turn.
   The normal image check refuses a missing or stale image with that remedy.

Settings retain the saved login when the input is blank. Replace it by pasting a new token;
use the explicit clear control to disconnect. Listing responses report configuration status,
and the input is not populated with the secret. A subscription API key does not replace this
web-session token. The gateway-wide account and its quotas are shared by eligible conversations.

## Ask the agent

For a short query:

> Delegate to the Perplexity research subagent: compare the current Node.js LTS lines using
> public official sources. Return a short answer with clickable citations.

For a longer investigation:

> Use Perplexity deep research to investigate the migration tradeoffs between those LTS lines.
> Give me the findings and their sources.

The managed MCP provides three tools:

| Tool | Purpose |
| --- | --- |
| `perplexity_research` | A self-contained question; `mode` is `quick` or `deep`, `source` is `web`, `academic`, `social`, `finance` or `all`. Quick mode accepts an optional supported model ID. |
| `perplexity_models` | Discover currently available quick-research model IDs and tiers. |
| `perplexity_usage` | Check remaining Pro Search and Deep Research quotas. |

Deep Research chooses its own model and can take several minutes. It cannot be combined with
an explicit model. The helper rejects unavailable model IDs and exhausted quotas rather than
switching to an independently billed API. Results include answer text, citation titles/URLs,
mode/model, quota before the request and a truncation flag. Prompts are limited to 16,000
characters; returned answers and citation lists are bounded. Cancellation stops the worker.

The researcher receives only the question and context the main agent sends. It has no workspace
tools, private connectors, login tools or uploads, and requests do not save to the Perplexity
library. Public web research can create provider-side processing records and consume quota;
the tools' read-only classification does not make requests free or private to the gateway.

## How the login reaches the container

The real token stays in the protected gateway settings file. Each eligible channel HOME receives
only a channel-bound relay placeholder at `~/.config/perplexity-web-mcp/token`. The egress proxy
substitutes that placeholder in the exact `__Secure-next-auth.session-token` cookie only for
`www.perplexity.ai`. It checks current integration settings, network policy, channel identity and
live-work authorization on every request. Rotation replaces the value at the proxy; clearing or
disabling the connection denies subsequent authenticated requests with an existing placeholder.
No raw session token is written into a channel folder, artifact, MCP configuration or CLI argv.

The MCP is available to eligible Claude/Codex turns, including read-only channels. Eligibility
requires a configured and enabled integration, a proxy container with network access on and
Lean off. Direct-host and legacy bridge runs do not receive the integration. A read-only channel
need not grant shell writes for the gateway to prepare its managed HOME login or run this MCP.
Lean suppresses newly injected tools, instructions and login delivery. It does not erase an
existing placeholder from the shared channel HOME while another admitted turn may be using it.
The proxy checks the current network setting independently of selected remote MCP hosts, so
turning network off also denies research authentication with an already-held placeholder.

## Operating limits

The image uses a pinned version of the
[unofficial Perplexity web client](https://github.com/jacob-bd/perplexity-web-mcp), with a smaller
ChannelGate MCP exposing only research, model discovery and quotas. Perplexity does not support
this bridge, and changes to its web endpoints can break login or queries. Model availability and
remaining quota depend on the connected account.

If a request fails, check the saved session login, network setting and subscription quota.
Reauthenticate with `pwm login` and replace the token when the session expires. The integration
has no gateway API-token pricing attribution; requests consume subscription quotas. A returned
answer should still be assessed against its cited sources.

Repository regression and pending deployed subscription acceptance are in
[`TEST-PLAN.md`](../TEST-PLAN.md#perplexity-research-delegation-acceptance-2026-10-07).
