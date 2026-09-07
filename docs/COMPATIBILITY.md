# Compatibility matrix

## What the GitHub checks prove

Continuous integration (CI) runs automatically on code changes. GitHub creates a disposable Linux
runner, installs the committed dependencies, checks syntax and sign-offs, scans for credentials
and dependency advisories, and runs automated tests and coverage checks on the supported Node
versions. A failed check includes the failing command and log; a green check applies to that
revision and those fixtures.

The nightly compatibility workflow reads its pinned Claude and Codex targets from
`containers/versions.json`, the same manifest used to build the runtime image. It probes the real
CLI interfaces and runs simulated transport tests without provider credentials. Separate latest
version probes report upstream drift.

Live acceptance uses a deployed gateway, actual chat interactions, authenticated model turns and
operating-system fixtures. Its test registry records setup, prompts, expected evidence, results
and retests. A green CI run is not a substitute for those live cases; their reproducible public
definitions are in `TEST-PLAN.md` and `docs/RELEASE-ACCEPTANCE.md`.

## Supported versions

| Component | Supported | Release gate |
| --- | --- | --- |
| Operating system | Linux (systemd) with rootless Podman; Ubuntu 24.04 tested | CI on Ubuntu |
| Node.js | 22.13 minimum; 24 LTS. SQLite FTS5 (channel-memory search index) is present from the later 22.x builds and 24; on a build without it the daemon boots and memory search uses a plain scan | Full matrix CI |
| Claude Code | Pinned nightly target `2.1.258` (official installer) | Real CLI surface + stub transport |
| Codex CLI | Pinned nightly target `0.153.4` | Real CLI surface + stub transport |
| SQLite | Built-in `node:sqlite` | Migrations + backup/restore quick-check |
| Slack | Socket Mode Slack app manifest in repository | Real workspace canary before promotion |

Compatibility is versioned with each Git tag. A CLI version outside the tested target is
best-effort until the nightly canary and full release checklist pass.
