# Release checklist

> 0.5.0 was published on 2026-09-06 by decision of the Licensor. Items still unticked below stay
> tracked for the next release.
> Current candidate: **0.6.0-rc.2** (2026-09-08), draft pending the planned full live QA campaign.
> The deferred QA gate is not waived.

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
- [ ] Candidate version/tag/changelog and `docs/COMPATIBILITY.md` match `v0.6.0-rc.2`;
      record the exact tag and verified evidence before checking this item.
- [x] CI, security coverage, dependency/secret scans, and real CLI nightly canaries are green (2026-09-06).
- [ ] Release workflow emitted the image SBOM, model hashes, exact image archive, checksums and
      verifiable GitHub artifact attestations for this candidate.
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
- [ ] Previous release and runtime snapshot retained for the rollback window.
