# Engine capability matrix

The executable source of truth is the validated manifest in `src/engines/adapters.js`; Slack and
the Admin API/UI consume that registry.

| Capability | Claude | Codex |
| --- | --- | --- |
| Filesystem confinement | Gateway settings + Claude permissions | Gateway read-only/workspace permission profiles |
| Network modes | off, approved-domain, unrestricted admin bypass | off, unrestricted admin bypass; approved-domain fails closed |
| Warm process / steer | yes | no; one-shot resume |
| Session identity | gateway-minted UUID | CLI-minted thread ID, persisted after the turn |
| Permission prompts | Slack approval tool | headless deny or auto-review in autonomous mode |
| MCP transport | protected per-run config file | complete safe `-c` definitions; user config ignored |
| Optional MCPs | selected host definitions | runtime apps plus credential-free stdio/HTTP definitions |
| Usage/cost | provider-reported cost | token usage with configured rate estimate |
| Health | adapter-owned `--version` boot probe | adapter-owned `--version` boot probe |

## Engine-literal exceptions

Engine IDs remain intentionally present in adapter implementations, persisted configuration and
migrations, compatibility tests/fixtures, user-facing copy, and engine-specific protocol decoders
(event source names and the Codex rate table). The generic run orchestrator, health path, settings
selectors, MCP selection key lookup, and Slack model wizard use the adapter registry.
