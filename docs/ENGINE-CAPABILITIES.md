# Engine capability matrix

The executable source of truth is the validated manifest in `src/engines/adapters.js`; Slack and
the Admin API/UI consume that registry.

| Capability | Claude | Codex |
| --- | --- | --- |
| Filesystem confinement | Per-conversation container mounts; Claude permissions control tools | Same container boundary; Read-only mode adds a CLI read-only sandbox |
| Network policy | Advisory off/on; container bridge networking, no domain filtering or egress firewall | Same container network boundary; CLI Read-only mode also restricts its own network access |
| Warm process / steer | yes | no; one-shot resume |
| Session identity | gateway-minted UUID | CLI-minted thread ID, persisted after the turn |
| Permission prompts | Interactive Slack tool approvals; automatic approval with Auto | Headless deny or eligible automatic review with Auto |
| MCP transport | Protected per-run configuration; HTTP/stdio servers and the gateway socket bridge | Per-run `-c` definitions; native HTTP with a credential helper for managed remote connections, stdio bridges for gateway/SDK |
| Optional MCPs | Explicitly selected server definitions | Selected runtime apps and complete credential-free stdio/HTTP definitions; managed credentialed integrations use separate protected paths |
| Skills | Organization/channel repository skills plus per-author grants | Native organization/channel repository skills plus a per-run personal skill catalog; personal delivery does not register slash commands |
| Usage/cost | provider-reported cost | token usage with configured rate estimate |
| Health | adapter-owned `--version` boot probe | adapter-owned `--version` boot probe |

## Engine-literal exceptions

Engine IDs remain intentionally present in adapter implementations, persisted configuration and
migrations, compatibility tests/fixtures, user-facing copy, and engine-specific protocol decoders
(event source names and the Codex rate table). The generic run orchestrator, health path, settings
selectors, MCP selection key lookup, and Slack model wizard use the adapter registry.
