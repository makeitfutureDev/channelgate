# Engine capability matrix

The executable source of truth is the validated manifest in `src/engines/adapters.js`; Slack and
the Admin API/UI consume that registry.

| Capability | Claude | Codex | Qwen harnesses (Claude Code CLI) |
| --- | --- | --- | --- |
| Filesystem confinement | Per-conversation container mounts by default; Claude permissions control tools. Admin-only Slack `/sudo` threads deliberately run on the host | Same default container boundary; Read-only mode adds a CLI read-only sandbox. `/sudo` deliberately runs on the host | Identical to Claude — same CLI, same lockdown file, same resolved runtime |
| Network policy | Advisory off/on; container bridge networking by default, direct daemon-account network in `/sudo`; no domain filtering or egress firewall | Same resolved-runtime policy; CLI Read-only mode also restricts its own network access outside bypass | Same advisory off/on as Claude |
| Warm process / steer | yes | no; one-shot resume | no; cold runs only, so a rotated provider key can never be served by a warm process |
| Session identity | gateway-minted UUID | CLI-minted thread ID, persisted after the turn | gateway-minted UUID (same CLI, same transcript layout, so session carry works unchanged) |
| Permission prompts | Interactive Slack tool approvals; automatic approval with Auto | Headless deny or eligible automatic review with Auto | Interactive Slack tool approvals, as Claude |
| MCP transport | Protected per-run configuration; HTTP/stdio servers and the gateway socket bridge | Per-run `-c` definitions; native HTTP with a credential helper for managed remote connections, stdio bridges for gateway/SDK | Identical to Claude, and shares Claude's per-channel selection key |
| Optional MCPs | Explicitly selected server definitions | Selected runtime apps and complete credential-free stdio/HTTP definitions; managed credentialed integrations use separate protected paths | Explicitly selected server definitions (the same selection Claude uses) |
| Skills | Organization/channel repository skills plus per-author grants | Native organization/channel repository skills plus a per-run personal skill catalog; personal delivery does not register slash commands | Same as Claude (`CLAUDE.md`, `.claude/skills`, plugin dirs) |
| Usage/cost | provider-reported cost | token usage with configured rate estimate | token usage only — the CLI's Anthropic-priced figure is dropped and no rate is inferred |
| Health | adapter-owned `--version` boot probe | adapter-owned `--version` boot probe | adapter-owned `--version` boot probe plus "is a QwenCloud key configured" |

The Qwen column covers every harness generated from the Anthropic-compatible **provider table** in
`src/engines/qwen.js` — today `qwen` (QwenCloud) and `qwen-eu` (Alibaba Cloud Model Studio, EU
region). They share this column because they share the CLI and every guarantee in it; what differs
per entry is the endpoint, the credential, the shipped and discovered model catalog, and the
gateway default model.

Each is **opt-in**: a missing `engineEnabled` entry means OFF, it is terminal in the failover graph
in both directions, and its provider credential (its own `…ApiKey` / `…BaseUrl` pair) is gateway
configuration — never a per-channel environment secret, because `ANTHROPIC_*` is reserved there
precisely so a conversation cannot redirect its own provider. Such a spawn removes the whole
Anthropic credential family before applying its own, so the operator's login never leaves with it.
A provider whose endpoint is account-specific ships no default and stays unconfigured — failing
closed with the remedy named — until an operator saves theirs.
OpenCode is omitted from the table above; see `docs/OPENCODE-ADAPTER.md`.

## Engine-literal exceptions

Engine IDs remain intentionally present in adapter implementations, persisted configuration and
migrations, compatibility tests/fixtures, user-facing copy, and engine-specific protocol decoders
(event source names and the Codex rate table). The generic run orchestrator, health path, settings
selectors, MCP selection key lookup, and Slack model wizard use the adapter registry.
