# Release checklist

> 0.5.0 was published on 2026-09-06 by decision of the Licensor. Items still unticked below stay
> tracked for the next release.

- [x] Authorized owner selected and documented the Makeitfuture Sustainable Use License; the
      bundled Poppins OFL notice is present and third-party components retain upstream terms.
- [ ] Counsel reviewed license **v1.3** — specifically §3.1 (dedicated deployments, per customer,
      customer's key), §3.2 + §4.5 (license keys, usage limits, anti-circumvention), §6 + `CLA.md`
      (inbound contribution terms), and §11 (Romanian law, Bucharest venue).
- [ ] Word-mark clearance for **ChannelGate** (CIPO and EUIPO, classes 9 + 42) recorded; the
      cancelled USPTO registration 5640807 (Cymax) and Cymax's continued use assessed by counsel.
- [x] Every commit in the candidate carries a `Signed-off-by` trailer per `CLA.md`, and any
      contribution predating the CLA has a recorded acceptance (all authorship is the Licensor's).
- [x] The published version's public-availability date is recorded in `CHANGELOG.md` (0.5.0 — 2026-09-06).
- [x] Version/tag/changelog and `docs/COMPATIBILITY.md` match the candidate (`v0.5.0`).
- [x] CI, security coverage, dependency/secret scans, and real CLI nightly canaries are green (2026-09-06).
- [ ] Release workflow emitted the image SBOM, model hashes, exact image archive, checksums and
      verifiable GitHub artifact attestations for this candidate.
- [ ] Encrypted backup completed and `npm run restore:drill` passed off production data.
- [ ] The Linux systemd service package passed install/restart/uninstall checks.
- [ ] Canary passed health, Slack, engine, approval, confinement, update, and rollback checks.
- [ ] Security/privacy contacts, subprocessors, retention, incident response, and support owner confirmed.
- [ ] Independent review has no unresolved critical/high finding (or documented authorized acceptance).
- [ ] Previous release and runtime snapshot retained for the rollback window.
