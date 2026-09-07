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
| None | — | The committed production lockfile has no reported vulnerabilities in the 2026-09-07 npm audit. Re-run the audit for each candidate; this is not a future guarantee. | Gateway maintainers | Next dependency update |

`@composio/core` remains at `0.14.0`: the proposed `0.18.0` requires Node >=22.22.3,
above this project's supported Node 22.13 floor. Review that update independently with a runtime
compatibility decision; a green test on Node 24 alone is insufficient.

## Reporting

Report suspected vulnerabilities privately to **contact@makeitfuture.com**. Include the affected
version, reproduction, impact, and suggested mitigation; do not include live credentials or client
data. We aim to acknowledge within three business days, provide a triage update within seven, and
coordinate disclosure after a fix is available. Supported versions are the latest release only.

If credentials may be exposed, revoke/rotate them first. Preserve relevant redacted logs and the
release/SBOM identifiers. Public issues and Slack channels are not security-reporting channels.
