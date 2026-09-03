# Contributing

ChannelGate (formerly Claude Gateway for Slack) is a self-hosted daemon that runs coding agents
inside a container per conversation. Contributions are welcome, and because the gateway executes
model output on someone's machine, review is strict about isolation, secret handling, and
cross-platform behaviour. Everything below is what a reviewer will actually check.

By contributing you accept the [Contributor License Agreement](CLA.md) — the `Signed-off-by`
trailer on each commit *is* that acceptance (CLA Section 7). Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

Requirements: Node **>= 22.13** (the floor is exact — `node:sqlite` is stable from 22.13 and the
daemon refuses to boot below it), Git, and Linux — the daemon refuses to boot anywhere else.

```bash
git clone <your fork> && cd <checkout>
npm install
cp .env.example .env      # fill in Slack tokens and ADMIN_PASSWORD for a live run
npm start                 # admin UI + health endpoint on http://localhost:4747
```

`.env` is gitignored and never committed. Runtime state (config, sessions, logs, the SQLite
database) lives outside the repository under the gateway runtime root, not in the checkout.
`INSTALL.md` covers a full working install; the tests below need neither Slack credentials nor a
running daemon.

## Run the checks

```bash
npm test                   # full node:test suite (test/*.test.js)
npm run test:coverage      # the same suite with the enforced coverage floors — what CI runs
npm run check:static       # syntax, undeclared identifiers, whitespace invariants
npm run secret-scan        # dependency-free credential scan over tracked files
npm run check:dco          # every commit in origin/main..HEAD carries a sign-off trailer
```

`npm run test:security-coverage` enforces the extra coverage floors on the security-critical
modules; run it when you touch authorization, confinement, secrets, or the admin API. A single file
runs with `node --test test/<name>.test.js`.

Tests must leave no scratch directories behind. Create temp directories with `tempDir(prefix)` from
`test/helpers.js` (never a bare `mkdtempSync(path.join(os.tmpdir(), …))`) — it registers them for an
exit-handler cleanup, and `npm test` also runs `scripts/test-scratch-sweep.mjs` first to sweep
anything a crashed run left in the system temp dir.

Every one of these must pass before you open a pull request. CI runs the suite on Node 22.13 and 24
on ubuntu-latest.

## Branch, worktree, landing lock

`main` is the served branch — a deployment runs the repository live from it — so it stays clean and
integration-only.

- One development thread means **one branch and one worktree**, created from current `origin/main`:
  `git fetch origin && git worktree add -b fix/<slug> ../<slug> origin/main`. Never edit or switch
  the canonical checkout.
- Work, test, and commit inside your own worktree. Nothing about another task's state can block
  your commits.
- Landing on `main` is serialized behind the repository's landing lock:
  `npm run with-landing-lock -- <command>`. Put the bounded refresh/test/merge/push script under
  that wrapper — never an investigation or a long build. As an outside contributor you do not land
  anything yourself; a maintainer merges your pull request under the same lock.
- Remove the worktree and delete the branch only after the commit is contained in `main`.
- `FEATURES.md` and `TEST-PLAN.md` are expected conflict hotspots. Reconcile them at landing and
  preserve both sides' entries; never resolve a conflict by dropping someone else's line.

## Commit rules

- **Sign off every commit**: `git commit -s`. The `Signed-off-by: Your Name <you@example.com>`
  trailer is how you accept `CLA.md`; a real name and a reachable address are required, and
  pseudonymous sign-offs cannot be accepted. Already committed without it? `git rebase --signoff
  <base>`. CI rejects the pull request otherwise (`scripts/check-dco.mjs`).
- **Conventional, imperative subject**, present tense, no trailing period:
  `fix: reject an unsigned commit range`, not `fixed stuff`.
- **One change per commit.** A refactor and a behaviour change are two commits.
- **Stage only your own files** — `git add <path>`, never `git add -A` / `git commit -a`. If the
  tree holds edits you did not make, leave them unstaged.
- Explain *why* in the body. The diff already says what.

## What we accept

Open a pull request directly for:

- **Bug fixes** with a regression test that fails before the fix.
- **Documentation** corrections and clarifications.
- **Tests** covering existing behaviour, especially the security-critical modules.
- **Platform adapters and engine runners** that follow the registry pattern described in
  `AGENTS.md`: a chat surface is an adapter plus a connector in `src/platforms/` with a complete
  capability descriptor; an engine is a runner plus an entry in `src/engines/registry.js`. Adding a
  `platform === "slack"` or `engine === "codex"` branch anywhere else is the thing those registries
  exist to prevent, and it will be sent back.

**Ask first** — open an issue or a discussion before writing code — for:

- new license tiers, limits, or anything touching license-key enforcement;
- anything under `src/ee/`, which is **proprietary, source-visible** code owned by MAKEITFUTURE
  S.R.L. and is **not** under the Sustainable Use License — its own terms are in
  `src/ee/LICENSE-EE.md`, and `LICENSE.md` §3.2/§4.5 make removing, disabling, or circumventing
  the key verification, the usage limits, or the usage reporting a licence violation. We are happy
  to take bug reports and security findings about it; we cannot take patches to it without a prior
  discussion and a signed CLA covering that directory. The same applies to the enforcement call
  site in `src/gateway/run.js` (`licenseAdmission()`) and to the `license_usage` schema;
- licensing, CLA, or trademark text (`LICENSE.md`, `CLA.md`, `TRADEMARK.md`, `docs/LICENSING-*`);
- new runtime dependencies — the project is deliberately close to dependency-free outside the
  Slack, MCP, and Composio SDKs;
- schema changes (migrations are append-only; an existing migration is never edited);
- anything that changes the security model.

## Where design notes go

Put a short design note in the pull request description: the problem, the option you chose, the
options you rejected, and how it is tested. That is the durable record for a reviewer. Larger
design documents, roadmaps, and audit notes are kept privately by the maintainers and are not part
of this repository — do not add a `docs/plans/` or a working-notes file to a pull request.

Behaviour changes update `TEST-PLAN.md` (the cumulative regression list) and, when they ship a
user-visible capability, `FEATURES.md` and `CHANGELOG.md`.

## Security issues

Do not open a public issue, discussion, or pull request for a suspected vulnerability. Report it
privately per [SECURITY.md](SECURITY.md) — `contact@makeitfuture.com`, with the affected version,
reproduction, and impact, and no live credentials or customer data. Rotate anything that may have
leaked before you report.

## The rules reviewers enforce

These are not style preferences; a change that breaks one of them does not merge.

- **Confinement is the product, and the container is the boundary.** Every turn runs inside the
  channel's own container: a per-channel HOME volume, only the work folder (plus its clean
  workspace and artifact dir) mounted, no host home and no gateway root on that side. Every channel
  folder still gets the lockdown settings — automatic memory off, curated permission allowlist,
  the MCP allowlist — as policy, never a `sandbox` block. An engine is never exec'd outside a
  container, and nothing a run can do changes what its container mounts. The boundary is
  filesystem and process isolation, not egress: *Allow network* is a per-channel switch the
  engines are told about, not a filter.
- **Secrets never ride a listing response.** Listing endpoints return `has*` and `last4` only. A
  value is fetched one at a time through the reveal endpoint, which re-checks the admin password
  and audit-logs what was revealed, never the value. New secret fields go in the reveal allowlist.
  Nothing is hardcoded and nothing is logged.
- **Linux only.** ChannelGate targets Linux with systemd and rootless Podman: no macOS/launchd
  branches, no BSD-tool assumptions — and still no `setsid` or other platform-specific binaries;
  prefer portable Node APIs over shelling out and keep shell POSIX-portable.
- **A run is never killed for being quiet**, and a waiting state always announces itself. Silence
  that looks like death is the bug the heartbeat and watchdog exist to prevent.
- **Platform capabilities are declared once and fail closed.** Read them through the capability
  helpers; an undeclared capability resolves to the least capable value.
- **Only admins get skipped permissions**, and authorization is checked before anything else runs.

## Questions

Usage and troubleshooting: [SUPPORT.md](SUPPORT.md). Licensing, commercial use, and partner
inquiries: `contact@makeitfuture.com` and [`docs/LICENSING-FAQ.md`](docs/LICENSING-FAQ.md).
