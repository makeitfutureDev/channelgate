# Security Policy

## Dependency advisories

Production dependencies are checked with:

```bash
npm audit --omit=dev --audit-level=high
```

- Critical and high advisories block a self-update and release. An exception requires a documented,
  time-bounded rationale and maintainer approval.
- Moderate advisories are reviewed in the same development cycle and recorded below when they
  cannot be fixed compatibly.
- Low advisories are batched into routine dependency maintenance.
- `npm audit fix --force` is never used without a separate compatibility design and review.
- Dependabot proposes updates weekly. The complete test suite and human review remain the merge
  gate.

The transactional updater stores only advisory counts in its public status. Reproduce full details
with the production audit command above and record any accepted exception in this file.

## Current reviewed exceptions

| Advisory | Severity | Applicability | Owner | Next review |
|---|---|---|---|---|
| `GHSA-frvp-7c67-39w9` via `@hono/node-server <2.0.5` and `@modelcontextprotocol/sdk` | Moderate | The vulnerable path is the Windows `serve-static` adapter. ChannelGate runs on Linux only, uses the MCP SDK over stdio, and does not import or expose Hono static serving. The MCP SDK currently constrains this transitive dependency to major v1; forcing major v2 is outside a compatible lockfile update. | Gateway maintainers | 2026-08-07, or immediately when the MCP SDK accepts node-server v2 |

## Reporting

Report suspected vulnerabilities privately to **contact@makeitfuture.com**. Include the affected
version, reproduction, impact, and suggested mitigation; do not include live credentials or client
data. We aim to acknowledge within three business days, provide a triage update within seven, and
coordinate disclosure after a fix is available. Supported versions are the latest release only.

If credentials may be exposed, revoke/rotate them first. Preserve relevant redacted logs and the
release/SBOM identifiers. Public issues and Slack channels are not security-reporting channels.
