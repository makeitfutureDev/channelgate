# OpenCode adapter admission boundary

OpenCode is available as a proof third engine, but only for an explicit **read-only, network-off**
profile. It is not a substitute for the Claude or Codex confinement paths.

## Why the restriction exists

The current official OpenCode permissions documentation states that the shell action runs with the
host user's filesystem, process, and network authority. It also says the shell resource is raw
command text, external arguments receive only best-effort warnings, and the external-directory
boundary applies to the shell working directory rather than every path passed to a command:

- <https://opencode.ai/v2/docs/permissions>
- <https://opencode.ai/docs/permissions/>

Those rules are model-tool policy, not an OS-level sandbox. The gateway therefore does not
expose OpenCode shell, edit, web, subagent, LSP, code-execute, skill, external-directory, or MCP
actions. `--pure` disables external plugins. The inline config carries both stable V1
`permission`/`agent` and current V2 `permissions`/`agents` forms; both the global policy and the
selected `gateway-readonly` agent default-deny every action, then allow only workspace-local read,
glob, grep, and list while denying `.env` reads. Requests for gateway write mode, approved-domain network, admin bypass, or MCP are
rejected before process spawn. Unknown capabilities remain denied by the adapter contract.

This restriction still trusts OpenCode itself to enforce its read-action path boundary. OpenCode
must not be enabled for hostile repositories or multi-tenant secrets until the gateway can wrap it
in a real OS-level sandbox and verify that boundary on Linux.

## Supported runtime contract

The official CLI documents `opencode run`, raw JSON events with `--format json`, session continuation
with `--session`, model selection with `--model`, model variants with `--variant`, attachments with
`--file`, plugin suppression with `--pure`, and `--version`:

- <https://opencode.ai/docs/cli/>

The adapter consumes those JSON events for text deltas, session identity, token usage, and reported
cost; resumes with the emitted session ID; uses the shared inactivity watchdog; and cancels the
detached process group on `AbortSignal`. It intentionally performs no MCP discovery and passes no
gateway/Composio/Skills/Toolbox credential bundle.

## Capability matrix

| Capability | OpenCode proof adapter |
|---|---|
| Workspace read/glob/grep/list | Supported |
| Structured JSON stream | Supported |
| Session identity and resume | Supported |
| Cancellation and stall watchdog | Supported |
| Usage and CLI-reported cost | Supported |
| Health/version | Supported |
| Filesystem writes or shell | Refused |
| Model tool network access | Refused |
| Admin/bypass mode | Refused |
| MCP and external plugins | Omitted/refused |
| OS-level confinement | Not provided; required before broader admission |
