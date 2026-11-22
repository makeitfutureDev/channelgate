# Engine capability matrix

The executable source of truth is the validated manifest in `src/engines/adapters.js`; Slack and
the Admin API/UI consume that registry.

## Harnesses and licenses

There are two **harnesses**: Claude Code (`claude`) and Codex (`codex`). Every other engine ID is
a **license** of one of them: one credential plus the server it talks to. `harnessOf(id)` in
`src/engines/registry.js` answers which harness a license belongs to, and each manifest entry
carries `harness`, `harnessLabel`, `licenseLabel` and `builtin`.

| License | Engine ID | Harness | Notes |
| --- | --- | --- | --- |
| Default sign-in | `claude` | Claude Code | The gateway's own Claude authentication |
| Claude Extra | `claude-bedrock` | Claude Code | Opt-in; its own Claude subscription login or a Bedrock bearer-key setup |
| Qwen (Claude Code) | `qwen` | Claude Code | Opt-in provider endpoint (QwenCloud) |
| Qwen EU (Claude Code) | `qwen-eu` | Claude Code | Opt-in provider endpoint (Alibaba Cloud Model Studio, EU region) |
| Default sign-in | `codex` | Codex | The gateway's own Codex login |
| Codex EU | `codex-eu` | Codex | Opt-in dedicated ChatGPT login |
| Codex (channel account) | `codex-channel` | Codex | One conversation's own Codex login; exists only in that conversation; Enterprise |
| ChatGPT sign-in (admin-added) | `codex-lic-<8 hex>` | Codex | Types: subscription, business, enterprise, education |
| Claude sign-in (admin-added) | `claude-lic-<8 hex>` | Claude Code | Types: subscription, business, enterprise; signed in with a command on the gateway host |
| API key or custom server (admin-added) | `claude-api-<8 hex>` | Claude Code | The Anthropic API or any `https://` server that speaks the Anthropic Messages API; key as `x-api-key` or bearer |
| Amazon Bedrock (admin-added) | `claude-aws-<8 hex>` | Claude Code | Region + Bedrock API key (bearer); `CLAUDE_CODE_USE_BEDROCK` |
| Google Vertex AI (admin-added) | `claude-gcp-<8 hex>` | Claude Code | Project + location + service-account key; `CLAUDE_CODE_USE_VERTEX` with gateway-minted access tokens |
| Microsoft Azure (admin-added) | `claude-azure-<8 hex>` | Claude Code | Foundry resource endpoint + key (`x-api-key` or bearer); `CLAUDE_CODE_USE_FOUNDRY` |
| API key or custom server (admin-added) | `codex-api-<8 hex>` | Codex | The OpenAI API or any `https://` server that speaks the OpenAI Responses API (`wire_api="responses"`; chat completions is not supported by the CLI) |
| Amazon Bedrock (admin-added) | `codex-aws-<8 hex>` | Codex | Region + Bedrock API key; Codex's built-in `amazon-bedrock` provider |
| Google Vertex AI (admin-added) | `codex-gcp-<8 hex>` | Codex | Project + location + service-account key; Codex's built-in `gcp` provider, whose token command reads the gateway-minted access token from the environment |
| Microsoft Azure (admin-added) | `codex-azure-<8 hex>` | Codex | Azure OpenAI v1 endpoint + key (`api-key` header or bearer), optional `api-version`, deployment names |

The eight kinds with a stored credential are **provider licenses** (types: api, business,
enterprise). Their facts — the fields each asks for, the ways its key may be sent, the header the
egress proxy may swap it into, and the hosts of its server — are declared once per kind in
`src/engines/license-state.js`; the store, the admin form, the relay rule and both runners read
them from there.

Admin-added licenses (`src/config/engine-licenses.js`, `src/engines/license-adapters.js`, at most
200) are registered live without a restart and are switched on when added. All of them are opt-in
cold runs with their own session directories: no warm pool and no interrupt/steer on a Claude Code
license. A sign-in license compares the plan its sign-in reports with the declared type, and a
mismatch makes it not ready. A provider license is checked against its server (its model list;
for Vertex, the exchange of the service-account key for a token at Google's fixed token endpoint)
when added, when its credential, server, region or key scheme changes, and on demand, never per
turn. It records a dollar figure only on the vendor's own API (Anthropic's reported cost, the
Codex estimate for `api.openai.com`), declares no `nativeFork`, and its sessions cannot be taken
over in a terminal. An added Codex license does not receive the default Codex login's MCP
configuration.

A provider license's credential never enters a container. The run receives the channel's
placeholder for that license; the egress proxy swaps it for the stored key — or for a Vertex
access token the daemon mints from the stored service-account key (`src/gateway/vertex-token.js`)
— only on that license's hosts and only in the header its kind declares. Outside the egress proxy
(the legacy bridge mode) a provider license refuses to run. A direct-host `/sudo` turn receives the
real value, with a Vertex token that has at least 50 minutes left. Codex is routed with per-run
`-c model_providers.*` overrides and reads the credential from one gateway-owned environment
name; Claude Code gets the route's own switches. On a cloud route, inherited or channel-stored
`AWS_*`, Google/Vertex and (for Claude Code) `ANTHROPIC_*`/Foundry variables are stripped from
that process so they cannot redirect the license.
Bedrock licenses take a Bedrock API key only: SigV4 keys sign the request, and a placeholder
cannot be substituted after signing.

A selection is a license plus an optional pool of more licenses of the same harness: none,
`"any"`, or an ordered list. It is stored as `engine` + `enginePool` in gateway settings, `engine`
+ `licensePool` on a channel or DM, a thread pin with its own pool, and `harness` + `licenses` on
a run API call. The shared picker shape (harness → license → model → effort) is
`src/gateway/license-pool.js`; the license step is omitted when a harness has a single usable
license in the conversation.

Failover order: the selection's other licenses first, in order, automatically — also in ask mode
and for a pinned thread — skipping a license that is switched off, not approved, not available in
the conversation, or unable to serve a picked model. Then the other harness, only under the
gateway failover setting and its ask/auto mode, never for a pinned turn. Only `claude`, `codex`
and admin-added licenses have a cross-harness edge, and its target is the other harness's own
sign-in; the other built-in licenses have no cross-harness edge in either direction.

The channel lock **Approved harnesses** (`approvedEngines`, Enterprise) holds license IDs and
`harness:claude` / `harness:codex` entries. A whole-harness entry admits every license of that
harness, including ones added later; a stored plain `claude` or `codex` entry admits only that
default sign-in; a lock that names only a removed license approves nothing. See
[license keys](LICENSE-KEYS.md#enterprise-channel-harness-approvals).

The lock also covers the `claude` every channel container carries for tools and terminals, which
is the gateway's own Claude login (the license `claude`): where the lock leaves it out, that
login is not loaded into the container, the egress proxy refuses its placeholder for that channel,
and `claude` starts signed out and says why. A terminal uses an added Claude license the channel
may use instead, when there is one.

"License" here means an engine license. The ChannelGate product license key is a separate thing,
documented in [LICENSE-KEYS.md](LICENSE-KEYS.md). The administrator guide to engine licenses is
[engine-licenses.md](../documentation/src/content/docs/features/engine-licenses.md).

## Built-in optional licenses

Two opt-in built-in licenses reuse the native runners: **Codex EU** (`codex-eu`) requires a
dedicated ChatGPT login (including Pro Lite; no Enterprise requirement), and **Claude Extra**
(retained engine ID `claude-bedrock`) accepts either its own Claude subscription login or an
isolated terminal setup with a regional Bedrock bearer API key. Both are cold, keep separate
session directories and have no cross-harness failover edges. Container authentication requires proxy egress;
`/sudo` uses the same dedicated host login/provider setup. Subscription authentication never
borrows regular Claude's login or API key. AWS setup, including an incomplete one, selects
Bedrock and never falls back to a subscription. Codex EU retains Codex token accounting;
Bedrock records tokens with unknown AWS cost. Claude Extra container terminal takeover is
unavailable; chat continuation still resumes its own session. See
[terminal setup and limitations](PROVIDER-HARNESSES.md).

## Capability matrix

Slack `/fork` requires the adapter's `supports.nativeFork` capability. Claude and Codex declare
it; Claude Extra, Codex EU and Codex channel accounts inherit it with their own session state.
The Qwen licenses and admin-added API key licenses do not declare it. A shortcut to a different engine uses a fresh
child with bounded Slack history, even when both engines share the same CLI.

| Capability | Claude | Codex | Qwen licenses (Claude Code CLI) |
| --- | --- | --- | --- |
| Filesystem confinement | Per-conversation container mounts by default; Claude permissions control tools. Admin-only Slack `/sudo` threads deliberately run on the host | Same default container boundary; Read-only mode adds a CLI read-only sandbox. `/sudo` deliberately runs on the host | Identical to Claude — same CLI, same lockdown file, same resolved runtime |
| Network policy | Off/on enforced by the per-channel egress proxy (`--network none` container; no per-domain filtering when on); advisory under the legacy bridge egress mode or a `rawNetwork` channel; direct daemon-account network in `/sudo` | Same resolved-runtime policy; CLI Read-only mode also restricts its own network access outside bypass | Same as Claude (the configured provider endpoint is reachable with the switch off) |
| Warm process / steer | yes | no; one-shot resume | no; cold runs only, so a rotated provider key can never be served by a warm process |
| Session identity | gateway-minted UUID | CLI-minted thread ID, persisted after the turn | gateway-minted UUID (same CLI, same transcript layout, so session carry works unchanged) |
| Permission prompts | Interactive Slack tool approvals; automatic approval with Auto | Headless deny or eligible automatic review with Auto | Interactive Slack tool approvals, as Claude |
| MCP transport | Protected per-run configuration; HTTP/stdio servers and the gateway socket bridge | Per-run `-c` definitions; native HTTP with a credential helper for managed remote connections, stdio bridges for gateway/SDK | Identical to Claude, and shares Claude's per-channel selection key |
| Optional MCPs | Explicitly selected server definitions | Selected runtime apps and complete credential-free stdio/HTTP definitions; managed credentialed integrations use separate protected paths | Explicitly selected server definitions (the same selection Claude uses) |
| Skills | Organization/channel repository skills plus per-author grants | Native organization/channel repository skills plus a per-run personal skill catalog; personal delivery does not register slash commands | Same as Claude (`CLAUDE.md`, `.claude/skills`, plugin dirs) |
| Usage/cost | provider-reported cost | token usage with configured rate estimate | token usage only — the CLI's Anthropic-priced figure is dropped and no rate is inferred |
| Health | adapter-owned `--version` boot probe | adapter-owned `--version` boot probe | adapter-owned `--version` boot probe plus "is a QwenCloud key configured" |
| Container login | a relay of the host's Claude access token in `CLAUDE_CODE_OAUTH_TOKEN` — behind the egress proxy the channel's `sk-ant-oat01-cgph_r…` placeholder, swapped on `api.anthropic.com`; refreshed by a cheap host turn (`src/gateway/claude-token-relay.js`); never a file | behind the egress proxy an ACCESS-ONLY `auth.json` in the channel HOME, written before each run: a JWT-shaped placeholder for a ChatGPT login or an API-key placeholder restricted to `api.openai.com`; no refresh token or real API key in the container. The host login can be gateway-wide or channel-specific. Legacy bridge mode keeps a read-write file mount | the gateway's provider key in `ANTHROPIC_AUTH_TOKEN`, raw (not relayed) |

The Qwen column covers every license generated from the Anthropic-compatible **provider table** in
`src/engines/qwen.js` — today `qwen` (QwenCloud) and `qwen-eu` (Alibaba Cloud Model Studio, EU
region). They share this column because they share the CLI and every guarantee in it; what differs
per entry is the endpoint, the credential, the shipped and discovered model catalog, and the
gateway default model and effort.

Each is **opt-in**: a missing `engineEnabled` entry means OFF, it is terminal in the cross-harness
failover graph in both directions, and its provider credential (its own `…ApiKey` / `…BaseUrl` pair) is gateway
configuration — never a per-channel environment secret, because `ANTHROPIC_*` is reserved there
precisely so a conversation cannot redirect its own provider. Such a spawn removes the whole
Anthropic credential family before applying its own, so the operator's login never leaves with it.
A provider whose endpoint is account-specific ships no default and stays unconfigured — failing
closed with the remedy named — until an operator saves theirs.

## Engine-literal exceptions

Engine IDs remain intentionally present in adapter implementations, persisted configuration and
migrations, compatibility tests/fixtures, user-facing copy, and engine-specific protocol decoders
(event source names and the Codex rate table). The generic run orchestrator, health path, settings
selectors, MCP selection key lookup, and Slack model wizard use the adapter registry.
