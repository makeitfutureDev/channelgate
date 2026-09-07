# Support

Where to go, in order.

## Before you ask

- [`INSTALL.md`](INSTALL.md) — installing, Slack app setup, first run.
- [`README.md`](README.md) — how the gateway works, configuration, security model.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — backups, retention, log rotation, upgrade and
  rollback.
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — supported operating systems, Node versions,
  and the pinned Claude Code / Codex CLI targets. A CLI version outside the tested target is
  best-effort.
- [`docs/LICENSING-FAQ.md`](docs/LICENSING-FAQ.md) — worked examples of what the license permits.

## Community support

Community support is best-effort, from the maintainers and other users, with no response-time
commitment.

- **Questions, ideas, "is this supposed to work like this?"** → GitHub **Discussions**.
- **Reproducible defects** → a GitHub **issue**, using the bug-report form.
- **Feature proposals** → the feature-request form. Proposals that change the security model, the
  license tiers, or anything under `src/ee/` are discussed before any code is written; see
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## What to include in a bug report

A report we can reproduce gets fixed; one we cannot gets questions. Include:

1. **Version** — the release tag, or `git rev-parse --short HEAD` in the checkout, plus the
   `version` from `package.json`.
2. **Operating system** — the Linux distribution and version, and how the daemon runs
   (foreground, systemd system unit, systemd user unit).
3. **Node version** — `node --version` (the floor is 22.13).
4. **Engine** — Claude Code or Codex, and the CLI version (`claude --version` / `codex --version`).
5. **Chat platform** — Slack, Google Chat, or Microsoft Teams, and whether it happened in a DM, a
   channel, or a thread.
6. **What you expected, what happened**, and the exact steps to reproduce.
7. **Relevant log excerpts, redacted.** Console output is centrally redacted for Slack/OpenAI-style
   tokens, bearer values, and secret query parameters before the service manager receives it (see
   *Retention and log rotation* in [`docs/OPERATIONS.md`](docs/OPERATIONS.md)) — but redaction is a
   safety net, not a guarantee. Read what you paste, and strip workspace names, user identifiers,
   file paths, and message content you would not publish. Never paste a token, a license key, or
   customer data into an issue.

Attach the smallest excerpt that shows the problem, not the whole log.

## Commercial and priority support

Contracted support is available to customers with an active support agreement with Makeitfuture
or an approved support partner. Response times, guided installs, deployment and operations help
are provided only as specified in that agreement; downloading ChannelGate or opening a GitHub
issue does not create a support entitlement. Support and enterprise inquiries go to
**contact@makeitfuture.com**.

## Contact and request handling

Use GitHub issues and Discussions to track public project defects, questions and proposals.
All direct requests — including support, commercial, legal and privacy requests — go to
**contact@makeitfuture.com**. Suspected vulnerabilities and requests containing personal or
confidential information stay private; do not put them in a public GitHub issue.

Makeitfuture handles requests about the published project. Each deployment operator handles
access, deletion and incidents involving data in their own deployment, as described in
[`docs/PRIVACY-AND-DATA-FLOW.md`](docs/PRIVACY-AND-DATA-FLOW.md).

## Partner inquiries

Agencies, resellers, white-label, and enterprise deployments: use the partner-inquiry issue form
for a first contact, or write to **contact@makeitfuture.com** directly. Operating separate
single-customer deployments needs no agreement — read
[`docs/LICENSING-FAQ.md`](docs/LICENSING-FAQ.md) first; reselling, white-labeling, or hosting the
gateway as a paid service does need one.

## Security

Never in a public issue or discussion. Report suspected vulnerabilities privately per
[`SECURITY.md`](SECURITY.md) — **contact@makeitfuture.com**. Rotate anything that may have been
exposed before you report it.
