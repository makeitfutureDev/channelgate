# Release checklist

> 0.5.0 was published on 2026-09-06 by decision of the Licensor. Items still unticked below stay
> tracked for the next release.
> 0.5.1 was published on 2026-09-21 by explicit owner decision after the full automated gate and
> CI passed on the exact candidate and a live smoke ran for Claude and Qwen. The owner released it
> without Codex live acceptance (the Codex account was usage-limited until 2026-09-24) and without
> the full live campaign; both remain open for the next release, see RELEASE-ACCEPTANCE.md.
> 0.5.4 was published on 2026-09-24 by explicit owner decision after the full automated gate and
> CI passed on the exact candidate. It carries one change on top of 0.5.3: Claude Opus 5.5 and
> GPT-6 Sol / Luna reach the gateway (Claude Code `2.1.281`, Codex CLI `0.156.1`, the Codex rate
> table). No live campaign ran; the owner is testing it on the deployment. Before the owner made
> GPT-6 Sol the deployment's default Codex model, a one-prompt Codex smoke on `gpt-6-sol` through
> the `0.156.1` CLI passed on Xavier. The image pins changed, so every other host must run
> `npm run build:image` before restarting — the daemon fails a run closed on a stale image.
> Everything 0.5.3 left open stays open.
> 0.5.3 was published on 2026-09-24 by explicit owner decision after the full automated gate and
> CI passed on the exact candidate and a live Claude campaign ran on Xavier through the QA actors
> (Apps, Contact) in the `cg-qa` fixtures, recorded in TEST-PLAN.md → "0.5.3 live acceptance". Codex
> live acceptance was skipped by owner instruction: the account was usage-limited until 10:40 on
> 2026-09-24, past the release window. SSH access was proven end to end: the container half with a
> real `ssh` client through `cg-sshd`, the shared VS Code server over an SSH port forward, and —
> after `scripts/install-ssh-access.sh` was rerun as root — the host-sshd hop with a GUI VS Code
> Remote-SSH client on the owner's Mac. Live testing found and fixed three defects before promotion
> (a guide that suggested a blanket prune; failover notices that never reached a streamed answer;
> interactive `claude` over SSH looking signed out: first-run onboarding never recorded, and SSH
> sessions starting without the container's environment), then made an SSH session the same
> environment a chat turn gets (lockdown, gateway + Composio + catalog MCP, secrets, an
> account-shaped access-only login) and stopped Claude self-updating inside channels. The image
> is spec 1.5.1 (an interactive SSH login starts in the channel folder); Atlas must run
> `npm run build:image`. The live re-check of the streamed
> failover notice stays open: it needs a Codex usage-limit failover on the running daemon. Carried forward as a known issue: the content-addressed
> `claude-plugins` cache under each channel's artifact dir is never collected (~14 GB on Xavier).
> Four administration-UI changes landed after that campaign ran and are therefore covered by the
> automated gate only — their `TEST-PLAN.md` live gates are still unticked: the channel-runtime
> reset's scope choice (*Channels only* / *Channels + threads*), that reset now clearing a
> channel's reasoning effort with its engine and model, the skill template picked in place on the
> Slack Settings page, and the VPN moved onto the row under the network switch. All four are Block
> Kit / admin-page interactions that only a human can exercise on a running daemon.
> 0.5.2 was published on 2026-09-22 by explicit owner decision after the full automated gate
> passed on the exact candidate. It carries the cross-engine failover spawn-contract fix, the VPN
> health-check fix and on-demand Google Drive sync. The owner again released it without Codex
> live acceptance — the same account was still usage-limited until 2026-09-24, which is the
> condition the failover fix addresses and therefore could not be exercised live — and without
> the full live campaign. The failover live gates in `TEST-PLAN.md` (both directions) and the
> items still unticked below remain open for the next release; see RELEASE-ACCEPTANCE.md.

- [x] Authorized owner selected and documented the Makeitfuture Sustainable Use License; the
      bundled Poppins OFL notice is present and third-party components retain upstream terms.
- [ ] Counsel reviewed license **v1.4** — specifically §3.1 (dedicated deployments, per customer,
      customer's key), §3.2 + §4.5 (license keys, usage limits, anti-circumvention), §6 + `CLA.md`
      (inbound contribution terms), and §11 (Romanian law, Cluj-Napoca venue).
      This is review evidence, not a claim that the existing text is unfinished.
- [x] Owner confirmed **ChannelGate** as the name and deferred registration to a later date
      (2026-09-07). This records the release decision, not trademark clearance or registration.
- [x] Every commit in the candidate carries a `Signed-off-by` trailer per `CLA.md`, and any
      contribution predating the CLA has a recorded acceptance (all authorship is the Licensor's).
- [x] The published version's public-availability date is recorded in `CHANGELOG.md` (0.5.0 — 2026-09-06).
- [ ] Freeze the exact 0.5.1 candidate; verify its package, lockfile, changelog and compatibility
      metadata and create its release tag only as part of approved promotion.
- [ ] The exact candidate passes all required automated checks, CI and applicable live gates
      defined in `AGENTS.md` and `TEST-PLAN.md`.
- [ ] Generate and independently verify 0.5.1 image inventories, model records, archive,
      checksums and exact-source attestations. Historical `v0.6.0-rc.2` evidence remains valid
      only for source `7842559b0350434a3651f66ce32e4bb74468c439` in the
      [earlier workflow](https://github.com/makeitfutureDev/channelgate/actions/runs/34165366930);
      it is not evidence for the renamed release or later beta changes.
- [x] Encrypted backup and `npm run restore:drill` passed using isolated synthetic data,
      including replacement restore with database/config verification (2026-09-08,
      [Linux lifecycle evidence](https://github.com/makeitfutureDev/channelgate/actions/runs/34164530300)).
      This does not claim a restore of this deployment's production data.
- [x] Linux systemd installation, restart, real CLI updater rollback and uninstall passed in
      the disposable lifecycle VM above; actual OS reboot, automatic service startup and
      database/container-volume persistence passed in the
      [separate guest reboot](https://github.com/makeitfutureDev/channelgate/actions/runs/34164530261).
      Rollback uses controlled engine smoke and test commands; authenticated canary remains below.
- [ ] Canary passed health, Slack, engine, approval, confinement, update, and rollback checks.
- [x] Project requests use GitHub; direct security/privacy/legal/support requests use
      `contact@makeitfuture.com`. Contracted support requires an active Makeitfuture or approved
      partner agreement (owner decision, 2026-09-07; `SUPPORT.md`).
- [ ] Candidate deployment retention, restore and incident procedures verified against
      `docs/OPERATIONS.md`; project contact details do not prove a deployment's deletion behavior.
- [ ] Independent review has no unresolved critical/high finding (or documented authorized acceptance).
      Historical review of the 0.6.0-rc.2 installer, lifecycle, scanner and release evidence found no
      critical/high issue; this does not close the separate legal, provider-account or live gates.
- [ ] Previous release and runtime snapshot retained for the rollback window.
