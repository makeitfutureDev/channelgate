# Release acceptance packet

Status: **prepared; full live QA deferred to the planned campaign** (owner instruction,
2026-09-08). Candidate: **0.6.0-rc.2**. These are reproducible definitions, not claimed
passes. Use disposable private fixtures only. Record the actual channel IDs, host/image revision,
engine/model versions, timestamps and evidence links when executing. No live chat/provider fixture
was created or used during the source remediation. A separate disposable container lifecycle test
passed against the existing installed image; it does not complete the candidate/provider cases
below. Private QA registry actions require the operator's selected personal connection. Current
release preparation does not execute or modify that registry; existing definitions remain pending.

Completed candidate evidence (2026-09-08): RR-15 passed for immutable tag `v0.6.0-rc.2`, source
`7842559b0350434a3651f66ce32e4bb74468c439`, in the
[release workflow](https://github.com/makeitfutureDev/channelgate/actions/runs/34165366930).
The downloaded nine subjects passed checksum and exact-source/tag/workflow attestation checks;
all 15 image layers and all 17 model entries matched their recorded hashes. Tagged CI reported
2,186 passes, zero failures and four explicit browser/live skips.

The [Linux lifecycle run](https://github.com/makeitfutureDev/channelgate/actions/runs/34165355246)
and [actual guest reboot](https://github.com/makeitfutureDev/channelgate/actions/runs/34165355203)
passed fresh installation, restart, encrypted synthetic database/config backup and restore,
real updater rollback, reboot/autostart, database/container-volume persistence and uninstall.
These cover operational portions of RR-06/RR-19, not all their live acceptance: updater fixtures
control engine smoke and test/pretest commands, and no authenticated first-message or real
channel/session recovery campaign ran. All other live rows remain unexecuted by this preparation.

For rows marked **both**, create separate Claude and Codex records and run each with that engine
explicitly pinned. Use approved non-admin test authors unless the setup names an admin. Suggested
fixture labels below are provisioning instructions; they are not assertions that those channels
already exist. Keep actual private IDs in the private acceptance record, not the public PR.

| ID | Engine | Private fixture/setup | Prompt or action | Evidence and pass rule |
| --- | --- | --- | --- | --- |
| RR-01 | independent | Disposable runtime and unrelated sentinel file; default mounts, home sharing off | Create a legacy editor-lease directory symlink in artifacts; inspect/reap the runtime | Sentinel bytes unchanged; lease metadata remains outside mounted artifacts |
| RR-02 | both | `qa-sdk-<engine>`; Enterprise; dummy personal/shared connections; API key | Submit an API run naming a different approved author, then request available connector identities | No personal SDK session; bridge refuses unsigned/out-of-scope destinations; shared session cannot manage connections |
| RR-03 | independent | Disposable API server; controlled DNS fixture; no real internal endpoints | Submit literal and DNS-provided mapped/expanded private IPv6 attachment/webhook destinations | Rejected before a connection; public pinned address succeeds |
| RR-04 | both | `qa-read-<engine>` with Read-only stored mode | Submit API overrides for Worker, Autonomous and Full access; ask to create a file | No permission widening; write denied; clean mode cannot be removed by an override |
| RR-05 | Codex | **Not shipped** (pending product decision on the credential model; remediation stays on the review branch) | — | — |
| RR-06 | independent | Fresh supported Linux VM, system Node and rootless Podman prerequisites; checkout under /opt | Run setup/service install, reboot, first message, update, restart and uninstall | Final service identity owns usable image store, subuid/subgid/runtime/cgroups work, service survives reboot, uninstaller keeps data |
| RR-07 | independent | Disposable no-key, free-key and signed Enterprise states | Start the same distribution under each tier and request SDK configuration/use | Baseline boot works without a paid key; SDK refuses without Enterprise and succeeds with it; licenses match these grants |
| RR-08 | Claude | **Not shipped** (pending product decision on the credential model; remediation stays on the review branch) | — | — |
| RR-09 | independent | Disposable admin server, dummy password and secret | Replace/remove password with missing, wrong and correct current password; retry old sessions | First two refused; correct proof succeeds; old sessions invalidated; proof masked in UI and absent from persisted state/logs |
| RR-10 | both | `qa-memory-<engine>`; two threads and reviewer enabled | Save distinct durable facts concurrently; repeat from independent gateway MCP processes | Every successful save remains; unsupported special files fail promptly; no daemon/DB hang; file/batch limits clearly reported |
| RR-11 | both | `qa-recovery-<engine>`; disposable append-only tool fixture and webhook receiver | Interrupt after a tool action, and separately after saved result/before delivery; restart | Unknown execution is surfaced for reconciliation without another tool action; saved result retries delivery only; stable webhook idempotency key |
| RR-12 | both | Separate private Google Chat and Teams conversations; Slack disconnected | Create a reminder and background job that writes a harmless fixture then reports completion | Destination connector delivers actual content; no Slack connection required; no empty-output substitute |
| RR-13 | both | Google Chat private fixtures A/B and controlled Pub/Sub input | Block A's first turn; submit another A message and one B message; stop/reconnect transport | B can proceed, A stays ordered; ACK follows durable acceptance; stop returns promptly; queued work survives and unknown running work is not replayed |
| RR-14 | independent | Isolated licensing responder using signed test keys | Rotate A→B while A verification is delayed, including two verifier processes | Only current key/current request state wins, for both successful and invalid/revoked delayed responses |
| RR-15 | independent | Exact release tag on main; clean CI builder | Execute release evidence workflow and download evidence | Audit/security/tests pass; image SPDX + model hashes describe actual build; checksum and GitHub attestation verification succeed |
| RR-16 | both | Disposable API-provider fixture and job output containing dummy credential values | Produce primary/fallback output, deltas and background output containing dummy keys | Values redacted on all user-facing paths; shell-only jobs do not inherit engine service credentials unnecessarily |
| RR-17 | independent | Fork without maintainer/private accounts | Follow CONTRIBUTING and public AGENTS; open a PR with this packet | Local checks and PR submission need no private QA account or publisher login |
| RR-18 | both | Enterprise SDK, then downgraded/no-key state | Switch SDK on; rotate entitlement and repeat; inspect Settings and platform selectors | SDK is Enterprise-only/Beta in UI and server; no silent identity substitution; Teams and Google Chat show Beta |
| RR-19 | independent | Disposable backup containing only synthetic data | Back up, restore into a separate runtime root, run integrity and startup checks | Decryption/SQLite integrity pass; config, jobs, memories and required paths recover without touching production |

RR-05 and RR-08 remain deferred credential-model proposals: retiring the shared writable Codex
sign-in mount and replacing the operator Claude access-token relay with a provider-approved API
credential arrangement. Existing deployments retain their current sign-in behavior. Review and
integration history is in [PR #11](https://github.com/makeitfutureDev/channelgate/pull/11);
merging that review did not ship these two proposals. Resolve the product decision and define
live acceptance before changing either credential path.

The memory publication contract is validation-first with cross-process serialization and atomic
replacement per file. A process crash can interrupt a multi-file batch; it is not advertised as a
filesystem transaction. Individual memory files and mutation batches are bounded, while total
channel storage remains operator-managed. Result delivery is at least once where the provider
cannot deduplicate an accepted request whose local acknowledgment was lost.

Release owner evidence outside these source tests: legal review of the current license/CLA;
the recorded name/registration decision in RELEASE-CHECKLIST.md; an account arrangement authorized
by each provider for the admitted users; candidate image/license notice review; actual
private fixture execution above. Record failures and waivers explicitly. A Beta label does not
convert an unexecuted acceptance case into a pass.
