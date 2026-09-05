# Compatibility matrix

| Component | Supported | Release gate |
| --- | --- | --- |
| Operating system | Linux (systemd) with rootless Podman; Ubuntu 24.04 tested | CI on Ubuntu |
| Node.js | 22.13 minimum; 24 LTS. SQLite FTS5 (channel-memory search index) is present from the later 22.x builds and 24; on a build without it the daemon boots and memory search uses a plain scan | Full matrix CI |
| Claude Code | Pinned nightly target `2.1.258` (official installer) | Real CLI surface + stub transport |
| Codex CLI | Pinned nightly target `0.152.0` | Real CLI surface + stub transport |
| SQLite | Built-in `node:sqlite` | Migrations + backup/restore quick-check |
| Slack | Socket Mode Slack app manifest in repository | Real workspace canary before promotion |

Compatibility is versioned with each Git tag. A CLI version outside the tested target is
best-effort until the nightly canary and full release checklist pass.
