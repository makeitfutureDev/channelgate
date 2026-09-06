# Remediation status — 7 September 2026

The source changes for all 17 findings are implemented in the release-readiness PR. This does
**not** certify the release for production: live provider/platform acceptance, a fresh-VM service
install, the actual tagged image-evidence workflow, and counsel/trademark review remain open.
The original review below is preserved as historical evidence, including its original priorities.

Product decisions: **Composio SDK is Enterprise-only and Beta**, with its implementation under
`src/ee` and server-side entitlement checks. **Google Chat and Microsoft Teams are Beta**.
Standard Composio MCP mode and core security protections remain available in every tier.

| Finding | Implemented remediation | Outstanding acceptance |
| --- | --- | --- |
| 1 | Editor leases moved to daemon-owned state; bind sources reject unsafe symlink components | Disposable live container boundary check |
| 2 | API principals receive no personal SDK session; signed bridge grants restrict destinations and connection management | Both-engine Enterprise SDK fixture; SDK Beta currently uses Slack identities |
| 3 | Numeric IPv4/IPv6 classification, mapped-address normalization and invalid DNS rejection | Automated fixtures cover the reported failure |
| 4 | Run mode overrides only reduce stored capabilities; clean mode stays reduced | Both-engine read-only fixture |
| 5 | Removed shared writable host Codex authentication; service API or independent channel-native login | Live two-channel login and image recreation |
| 6 | Provision/probe/build as final rootless service identity, subordinate mappings, user-runtime boot ordering and checkout preflight | Fresh supported VM install/reboot/update/uninstall |
| 7 | License 1.3/EE grant permits unchanged bundled enforcement in authorized no-key/free-key use and distribution | Counsel, ownership and trademark review |
| 8 | Retired operator subscription relay/setup-token use for daemon Claude; require supported API/provider credentials | Operator service credentials and live provider acceptance before upgrade |
| 9 | Password replacement/removal verifies current password; transient proof is not persisted; masked UI confirmation | Manual browser confirmation |
| 10 | Cross-process serialization, bounded nonblocking reads, pinned parent descriptors and rollback on ordinary write failure | Multi-file crash publication remains explicitly non-atomic |
| 11 | Persist execution/output/delivery separately; unknown interrupted runs require reconciliation instead of replay | Live crash/restart fixtures; delivery remains at least once |
| 12 | Schedules/background delivery use destination connectors without Slack; fixed actual non-Slack result content | Google Chat/Teams acceptance with Slack disconnected |
| 13 | Durable Chat acceptance before ACK, bounded parallel conversations, FIFO ordering and prompt intake stop | Live Pub/Sub reconnect/redelivery fixture |
| 14 | Cache/request state is bound to the active license key; SQLite coordinates verifier generations across processes | Automated reversed-order and child-process tests |
| 15 | Patched qs override; direct release audit/candidate checks; installed-image SBOM/model hashes and attestations; history/artifact scanning | Run tagged workflow and verify image evidence/notices; root audit alone does not audit all image packages |
| 16 | Reconciled filesystem/network/credential/provider/licensing statements and migration instructions | Deployment-specific disclosure/retention review |
| 17 | Public contribution requirements use reproducible PR evidence; private deployment rules belong in an ignored overlay | This session's private QA registry writes still need the selected personal connection |

Independent follow-up review also prompted protection against blocking memory special files,
service-secret output leakage (including fallback and jobs), plaintext password prompts,
commit/tag-message scan omissions, repeated scanner findings, and missing installed peer edges
in the npm inventory. These are included in the candidate's tests and verification record.

Cleanup completed: consolidated launch/asset instructions into `docs/MAINTAINER-RELEASE.md`,
removed references to nonexistent promotional assets, shortened duplicated legal rationale,
replaced generic headless UI/widget/Swift scaffolding with the actual runner contract, corrected
Linux/bootstrap examples, and ignored generated release evidence. Retained migration/backup/
restore code, the lockfile, `private: true`, tests, notices, authorship and canonical instruction
symlinks because they still serve supported deployments. Broad monolith rewrites are deferred;
this change extracts the IP policy and Enterprise implementation without a speculative rewrite.

**Upgrade action:** configure service API credentials before restarting, and rebuild the runtime
image. The old shared Codex mount disappears on managed recreation; generated relay artifacts are
retired by the updated container init. Subscription-only Claude daemon installations now fail
closed with a configuration remedy. VS Code attachment exports no daemon or channel secrets.

Live acceptance definitions and pass rules are in [RELEASE-ACCEPTANCE.md](docs/RELEASE-ACCEPTANCE.md).
The 19 scenario definitions specify applicable engines; private fixture IDs and actual results are
filled in when executed. They are not fabricated live passes or a claim of an Airtable write.
Legal and release gates remain in [RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md).

## Candidate verification

Local validation on Node 22.22.2, 7 September 2026:

- Full regression with coverage: **2,022 tests; 2,021 passed; zero failed; one opt-in live test skipped**.
  Aggregate coverage (including test sources) was 92.59% lines, 82.19% branches and 87.14% functions;
  all configured floors passed. Dedicated security-area coverage gates also passed.
- Static validation: **523 JavaScript files** passed syntax, undeclared-identifier and whitespace checks.
- `npm audit`: **zero vulnerabilities** for the patched root lockfile. This is not a full image audit.
- The opt-in real-container durability test passed separately with no skips. A disposable HOME/tool
  fixture, `/tmp` and `/var/tmp` survived stop/restart/recreation; its container and volume were
  removed. This used the existing installed host image, not a newly built candidate image.
- Local npm inventory/build metadata generation, DCO checks and bundled skill validation passed.
  The candidate-history/artifact scan and GitHub PR checks are recorded in the PR evidence.

No production restart, provider credential change, private QA registry write, live chat/provider
acceptance or tagged release publication was performed. The PR is held for the external gates above.

---

# Original review (historical)

ChannelGate public-release review — 6 September 2026

I would hold this release. The primary concerns are broken security boundaries, inconsistent licensing, and an installation path that has not caught up with the container architecture. Removing a few files or adding more documentation would not resolve them.

The evidence is frozen at commit `0f22fdbbac791eb44417035d5ac8e817b0e0c37a`, plus the five existing working-tree changes in FEATURES.md, TEST-PLAN.md, src/slack/app.js, src/slack/model-wizard.js, and test/model-wizard-buttons.test.js. No project files were changed by this review. The snapshot is `/tmp/channelgate-public-review-sku5rdb4`.

All 625 tracked files were inventoried (132,079 lines across source, tests, documentation, lockfile and symlink targets; this is not a production-code line count). Static checks covered 502 JavaScript files. Manual review was risk-directed across runtime, engines, control plane, chat surfaces, orchestration, persistence, scripts, public documentation and licensing. This is a broad repository audit, not a claim that every line received independent manual certification. Large historical/reference documents and migration bodies were selectively examined. Two delegated code-review passes were interrupted before their final coverage reports; the main security findings below were independently checked against source and temporary fixtures.

Verification completed:

- Full existing regression suite: 1,969 tests, 1,968 passed, zero failed, one live-container test skipped, using Node 22.22.2. The first sandboxed attempt encountered environment restrictions; the successful run used the isolated snapshot with those test restrictions lifted.
- Static check: 502 JavaScript files passed syntax, undeclared-identifier and whitespace checks.
- Shipped secret scan: 615 tracked-file entries passed its supported credential patterns. This does not establish that every secret format, Git history, release archive or ignored local file is clean.
- npm audit: three moderate affected-package findings, zero high or critical. These concern qs and its dependent body-parser/Express chain, not three independent confirmed application exploits.
- Release reviewer additionally ran 50 licensing/DCO assertions successfully.
- New temporary-fixture checks reproduced the editor-lease boundary failure, SDK identity suppression failure, read-to-auto override, concurrent memory loss, password reauthentication bypass and Google Chat dispatch/shutdown blocking. No live customer/provider credentials or production files were used.
- No fresh privileged-host install, real Podman confinement acceptance, live dual-engine chat acceptance, real backup restoration, trademark clearance, ownership-document verification or provider commercial approval was performed.

The findings below use P1 for issues I would resolve before release, and P2 for important defects or release-quality gaps. These are review priorities, not formal CVSS scores.

1. **P1 — Editor-lease cleanup can delete files outside the channel boundary.**

   At `src/runtimes/container/editor-lease.js:81`, activeEditorLeases reads the `editor-leases` directory beneath the channel-writable artifact directory using ordinary path-based filesystem calls. It then removes invalid JSON records at lines 91–93. A symlinked directory is followed in the daemon's host filesystem. The validity signature protects the contents of a lease; it does not establish that the directory being cleaned is actually a lease directory.

   A fixture containing an unrelated sentinel JSON file outside the artifact directory lost that file when cleanup ran. The path is exercised by routine lease counts and reaper operations (`src/runtimes/container/reaper.js:79`), not only when someone attaches VS Code. This needs no timing race. Impact is host-file deletion with the daemon user's permissions, potentially including configuration or credentials; this is not a demonstrated root/kernel escape.

   Move daemon-owned lease metadata outside agent-writable storage. Use descriptor-anchored, no-follow operations where the daemon must traverse untrusted filesystem trees, and never delete an unexpected node merely because it is not a valid lease. Add regression coverage proving unrelated fixture files survive symlinked directories and path replacement.

2. **P1 — SDK-mode API runs can obtain a personal connector identity selected by the caller.**

   `src/gateway/api-runs.js:741` correctly marks the supplied author as untrusted. Personal-mode token resolution respects that. But `src/gateway/run.js:573` unconditionally creates an SDK session with `kind: user`, the supplied author ID, `accessKind: owner` and `manageConnections: true`. The caller at line 1041 does not pass a trust restriction into this resolver. The endpoint is injected as composio-user by `src/gateway/mcp.js:131`; the SDK socket branch does not restore that missing identity check.

   The fixture returned a personal endpoint for an untrusted synthetic author. A real attack requires a valid run-API key, SDK mode, the corresponding workspace context and an existing victim identity in that Composio workspace. It does not require stealing the victim's random session URL: the gateway creates one. The risk reaches the victim's connected accounts.

   Propagate trusted-principal state into SDK resolution and suppress personal SDK sessions for untrusted API authors. Bind SDK bridge access to the signed service, identity and session scope. Test the full API → SDK → MCP path, including absent or false trust claims.

3. **P1 — The outbound URL filter accepts IPv4-mapped internal IPv6 addresses.**

   `src/web/security.js:141` strips a textual `::ffff:` prefix, then applies dotted IPv4 regular expressions. WHATWG URL parsing canonicalizes a mapped address into hexadecimal form; this bypasses those expressions. The actual resolvePublicHttpUrl function rejected ordinary loopback but accepted its mapped IPv6 equivalent. `src/gateway/api-runs.js:361` uses this validator for daemon-side attachment downloads and webhook requests.

   An authenticated API caller can therefore reach addresses the API promises to exclude, including mapped loopback and private/link-local targets, subject to host networking and the target service's own authentication. DNS pinning does not repair an incorrect address classifier.

   Parse addresses numerically, normalize mapped IPv4, and apply complete CIDR checks to the normalized value. Add mapped, compressed and expanded IPv6 regression cases. No request to a real internal service was made during verification.

4. **P1 — A run-API mode override can increase a read-only channel's privileges.**

   `src/gateway/run.js:622` copies the selected profile's flags and only prevents introduction of adminMode. It does not constrain allowBash or autoMode to the stored policy. A fixture with both flags false became allowBash=true and autoMode=true after an auto override. This contradicts the function's reduce-only contract and `FEATURES.md:1426`.

   The risk requires a run-API key and a selected channel; it grants writable/automatic tooling within the container, not the admin bypass. Intersect requested permissions with the channel's durable maximum and explicitly reject widening requests. Add tests for every permission dimension, not only the admin flag.

5. **P1 — Every container can receive the same writable Codex sign-in file.**

   `src/runtimes/container/lifecycle.js:166` mounts the resolved host auth.json read-write. `src/runtimes/container/credentials.js:14` explicitly describes sharing the gateway login across all channels. A writable channel therefore has a path to read or corrupt the credential used by the operator and other containers. This is an intentional implementation choice, but it is incompatible with a strong claim that channel credentials are independently confined. Claude-only containers also receive this mount when the host Codex login exists.

   Use a supported broker or independent author/channel authentication that does not expose a shared writable refresh credential. Simply changing the mount to read-only can break token refresh; copying a rotating credential can also break refresh semantics. The authentication architecture needs a deliberate replacement.

   Separately, a new host auth-file inode is diagnosed at `src/runtimes/container/index.js:216`, but the mount fingerprint at `lifecycle.js:229` records path strings rather than file identity. Existing containers can retain a stale sign-in file after host login replacement. This subissue needs live acceptance because bind-mount behavior is runtime-dependent.

6. **P1 — The documented systemd installation does not provision the runtime it will run as.**

   `scripts/install-systemd.sh:53` creates a system account; lines 113–117 switch to that account and HOME; line 127 sets NoNewPrivileges. The script does not allocate subordinate UID/GID ranges or establish a rootless user runtime/cgroup environment. `scripts/install.sh:99` builds the image as the invoking user, and `scripts/build-image.mjs:168` embeds that user's UID/GID. Podman storage and image availability are per user. NoNewPrivileges also conflicts with the usual setuid mapping-helper setup.

   This is a source-confirmed installation gap; I did not install onto a clean privileged host. Provision the final daemon identity first, establish its mappings/runtime delegation, build and probe the image as that identity, then apply compatible systemd hardening. Require a real clean-host install → first message → restart → update → uninstall test. Do not remove hardening blindly.

   References: [Podman rootless operation](https://docs.podman.io/en/stable/markdown/podman.1.html), [upstream useradd behavior](https://raw.githubusercontent.com/shadow-maint/shadow/master/man/useradd.8.xml).

7. **P1 — The licenses contradict the product's advertised no-key use and redistribution rights.**

   Root LICENSE.md section 3.2 permits no-key operation; section 3 permits specified free redistribution. But `src/ee/LICENSE-EE.md:14` permits use only with a valid key, and line 20 prohibits copying/distribution without separate written permission. Ordinary daemon startup unconditionally imports the EE modules at `src/server.js:47`. A complete working distribution necessarily includes them. This also makes contribution/fork examples difficult to reconcile with the actual grant.

   Explicitly permit unchanged EE enforcement components as part of every authorized ChannelGate installation, including no-key evaluation and authorized distribution, or separate the core so it can operate without those components. Reconcile the root license, EE terms, CLA, FAQ and summaries together. Ordered permissions and subsection numbering also produce ambiguous references such as Section 3.3; renumber them consistently.

   The repository is correctly labeled source-available, not OSI open source. Public GitHub availability does not change that. If the intent is open source, the commercial-use and redistribution restrictions must change; if the intent is proprietary/source-available distribution, retain that clear label. The restrictions do not satisfy the [Open Source Definition](https://opensource.org/osd). Repository text alone cannot establish copyright ownership, enforceability or trademark clearance.

8. **P1 — The shared Claude subscription-token relay needs provider approval or a supported replacement.**

   `docs/OPERATIONS.md:41` and the Claude login/token-relay modules describe relaying one operator's subscription access token into team channels. Anthropic's current documentation restricts routing Free/Pro/Max requests on behalf of users and intermediating Claude.ai credentials/session tokens. Its guidance distinguishes end-user sign-in to an unmodified binary from provisioning internal organization API credentials.

   This is a material conflict between the advertised team authentication model and provider-stated terms, not a finding that publishing the source itself is unlawful or that every deployment is prohibited. Make an expressly permitted organization API/provider setup the default, or obtain written approval covering this arrangement. Provider approval and legal review are not replaced by the repository's own license.

   References: [Claude Code legal and credential requirements](https://code.claude.com/docs/en/legal-and-compliance), [Anthropic consumer terms](https://www.anthropic.com/legal/consumer-terms).

9. **P2 — Password changes defeat the intended secret-reveal reauthentication.**

   `src/web/routes/settings.js:402` accepts a new admin password from an existing session without checking the current password. The same session can therefore reset the password, log in with the replacement, and satisfy the password check for revealing previously stored secrets. This was reproduced with dummy credentials. It is a session-compromise escalation, not an unauthenticated login bypass.

   Require the current password or an equivalent recent authentication proof for password changes and removal. Audit other sensitive administration operations against the claimed reauthentication boundary rather than assuming the reveal endpoint establishes it by itself.

10. **P2 — Concurrent memory saves silently lose durable facts.**

    `src/gateway/channel-memory.js:285` reads the index, edits a private in-memory copy, then writes it at line 324. The comment explicitly accepts last-writer-wins. Ten simultaneous successful fixture saves left only one fact. This can happen between independent threads or foreground work and the background memory reviewer.

    Atomic rename protects against torn files; it does not protect read-modify-write transactions. Serialize by channel across processes, or store mutations transactionally in SQLite and materialize the file. The advertised all-or-nothing batch is also validation-atomic rather than a transaction across multiple topic/index writes; clarify or strengthen that guarantee.

11. **P2 — API restart recovery replays a fresh run without establishing that prior side effects are safe to repeat.**

    `src/gateway/api-runs.js:208` rehydrates running rows and reuses the original prompt. The driver passes sessionId again at line 735; `src/gateway/run.js:880` treats a supplied session ID as a new session. The API job is only updated with the actual returned engine/session ID after completion. A crash after a tool mutation but before result persistence therefore has no durable evidence permitting safe replay. One-time schedules similarly tie retirement to delivery rather than a durable completed-execution/outbox boundary.

    This is a source-level recovery risk, not a demonstrated duplicate production mutation. Persist execution checkpoints separately from delivery; resume the actual engine session when possible, retain completed results for delivery-only retries, and treat unknown mutation outcomes as requiring reconciliation. A two-attempt ceiling limits repetition but does not make it safe.

12. **P2 — Teams/Google Chat automation still depends on Slack being connected.**

    `src/gateway/scheduler.js:119` returns before scheduling work whenever the Slack client is unavailable. `src/gateway/background.js:713` similarly postpones delivery without that client. The non-Slack adapters retain reminder/background guides and advertise proactive delivery. A Teams-only or Google-Chat-only installation therefore exposes operations that cannot complete through these paths.

    Resolve delivery readiness through the target platform's connector. Otherwise explicitly disable and document those operations on unsupported surfaces. Include acceptance with Slack disconnected, not merely with a fake Slack client present.

13. **P2 — A long Google Chat turn blocks other incoming messages and transport shutdown.**

    `src/platforms/googlechat/pubsub.js:94` acknowledges the batch, then line 106 awaits each full event handler sequentially. The transport awaits message ingestion, which can run an entire AI turn. A two-message fixture showed the second message blocked behind the first and stop() remaining pending until the first finished; the second still dispatched after stop was requested. A crash also loses already-acknowledged, unpersisted messages.

    Persist inbound acceptance before acknowledging, dispatch with bounded concurrency and per-conversation ordering, and separate transport shutdown from waiting on arbitrary AI work. This is distinct from limiting the global engine concurrency.

14. **P2 — License-key rotation races asynchronous verification.**

    `src/ee/license.js:518` and line 527 persist a response without rechecking which key is currently configured. The reviewer reproduced an old key's delayed response overwriting the newly verified key's entitlement. Cache reads also need to bind to the active key hash.

    Discard stale verification generations and validate key binding both before writes and on reads. Test reversed response order and delayed revoked/invalid responses as well as successful responses.

15. **P2 — Dependency and release-evidence gates do not fully cover the shipped product.**

    The installed lockfile's qs 6.15.3 is affected by two moderate advisories; npm reports three affected-package records including dependent Express/body-parser. Fix the lockfile to a compatible patched dependency set and rerun the suite. Exploitability through ChannelGate was not established. The maintainer identifies qs 6.16.0 as patched for the [isBuffer denial-of-service advisory](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g); see also the [array-limit advisory](https://github.com/ljharb/qs/security/advisories/GHSA-x5fp-wj9c-mxmx).

    `.github/workflows/release.yml:20` does not run npm audit, although SECURITY.md describes high/critical findings as release-blocking. Main/PR CI is not a fresh audit of every tag or manual candidate. Put the audit and candidate/tag validation directly in the release job.

    `scripts/release-artifacts.mjs:14` inventories only the root npm lockfile and misnames 23 nested dependency entries. It omits the container's OS/Python packages, engine CLIs and models. Its unsigned provenance only names package-lock.json as a subject. Generate an inventory/attestation from the actual release image and source revision, or accurately describe the current files as lockfile inventory/build metadata rather than full release provenance.

    The shipped secret scanner is useful but narrow: tracked current files only, selected credential shapes, no full-history scan, and exclusions for the lockfile/assets. Extend release scanning to all publishable artifacts and Git history. No actual leaked credential was identified by the shipped scan in this review.

16. **P2 — Public security/privacy claims are materially inconsistent.**

    `README.md:82` attributes filesystem confinement to the settings file, rather than the container. Line 94 claims data stays on the operator's infrastructure without distinguishing storage from model/connector transmission. Lines 116–119 make credential-at-rest claims that do not capture shared Codex authentication, channel CLI homes and per-run artifacts. `docs/LICENSING-FAQ.md:115` says the license key leaves hashed, but verification sends the raw key at `src/ee/license.js:498`; the detailed privacy document describes this more accurately.

    Keep one authoritative threat/data-flow model. Short summaries must distinguish local persistent state, model/connector transmission, licensing telemetry, advisory network policy, shared authentication, and the optional whole-home mount. Hashing channel identifiers is pseudonymization, not a universal claim that all transmitted data is anonymous.

17. **P2 — Public contributor instructions assume private operator access and a production checkout.**

    `AGENTS.md:319` makes private Airtable QA records mandatory; its landing instructions require a specific organization's GitHub identity and treat main as the locally served production branch. Those are legitimate internal operating rules, but external contributors cannot follow them. `INSTALL.md:159` still describes organization membership as an authorization prerequisite. `.gitignore:8` describes a private task-ledger workflow expressly forbidden by current project instructions.

    Separate public contribution/build/test requirements from deployment-specific operator instructions. Keep organization QA and production landing rules in an internal overlay; describe how public contributors submit evidence without access to private systems. Preserve author/copyright attribution—those names are legitimate notices, not clutter to scrub.

File removal and simplification recommendations:

- Move or sharply shorten `docs/LICENSING-DECISION.md`: internal rationale, obsolete decisions and inaccessible planning references do not belong in the operative public license explanation. Retain a concise accurate history where needed.
- Consolidate overlapping licensing summaries around LICENSE.md, the EE exception, one practical FAQ and one data-flow document. Multiple summaries already disagree; reducing duplication reduces legal drift.
- Move `.github/REPO-METADATA.md` and `docs/assets/README.md` to a maintainer launch runbook if they are not intentionally public. They are production instructions, not product functionality. Add the real demonstration/social image instead of making missing assets part of the public pitch.
- Split `.claude/skills/headless-app-creator/`: retain the runner/streaming contract the project uses; move unrelated Swift, generic widget and product-scaffolding guidance elsewhere. Its main skill alone is 1,360 lines.
- Consider retiring `scripts/migrate-skills-manager.mjs` only after defining the oldest supported installation and verifying that migration is no longer needed. Do not delete migration code merely because fresh installs do not call it.
- Fix Linux-incompatible `/Users/` examples and stale open-admin-default wording in `.env.example`. Ignore generated release output such as `dist/` if it is not intended to be committed.
- Keep `package.json`'s `private: true` if this is distributed through Git/container installation. It prevents accidental npm publication; it does not make the GitHub repository private.
- Keep the lockfile, tests, fixtures, compatibility canaries, backup/restore scripts, migration history, AUTHORS/CLA/security/support documents and font licenses.
- Keep AGENTS.md's CLAUDE.md/GEMINI.md/HERMES.md symlinks; they avoid duplicated instruction text. All three tracked aliases are symlinks, and no zero-byte tracked files were found.
- Do not delete `src/runtimes/local.js` solely because there is one channel runtime: it is used for daemon-owned smoke/test spawning and is not registered as a channel backend.
- Treat the optional OpenCode adapter as a scope decision. Keep it with an explicit experimental support boundary and its tests, or retire the runner, registry entry, tests and docs together. A filename alone does not establish dead code.

The dependency license metadata is mostly reassuring: all 184 lockfile dependency entries have license metadata (165 MIT, 11 ISC, 3 Apache-2.0, 3 BSD-3-Clause, 1 BSD-2-Clause, 1 Unlicense), with no apparent copyleft conflict in that inventory. Poppins ships copyright attribution and the full OFL. That does not constitute an audit of all container binaries, models or transitive notice files. Before distributing a built image, inventory that image's actual contents and expand THIRD_PARTY_NOTICES.md accordingly. Identify the Contributor Covenant's third-party terms explicitly too. DCO trailer checks validate syntax; they cannot establish identity, ownership or informed acceptance on their own.

The main maintainability concern is concentrated policy complexity. public/app.js is 4,036 lines, run.js is 1,891, and config/settings.js is 897. Split by behavior and policy ownership after the release blockers are fixed; a wholesale rewrite before release would add risk. The tests have substantial value, but 81 of 237 test files read application source as text. Such assertions can protect wiring, yet they do not substitute for behavior at real boundaries. The defects found here need tests combining identities, modes, filesystem mutation, process lifecycle and platform transport.

Before calling the release ready, I would require the P1 items resolved, regression tests for the reproduced failures, reconciled license/provider terms, a clean-host service install and restore drill, and actual Claude/Codex acceptance in isolated private fixtures. Teams/Google Chat should either pass their own disconnected-from-Slack acceptance or carry an explicit limited-support designation. The repository's release checklist already records publication of 0.5.0 while several of these gates remain unchecked; I did not independently confirm current GitHub visibility.

Evidence files retained outside the repository: `/tmp/channelgate-review-tests-unrestricted.log`, `/tmp/channelgate-review-static.log`, `/tmp/channelgate-review-npm-audit.json`, `/tmp/channelgate-review-evidence.jsonl`, `/tmp/channelgate-review-surface-repros.mjs`, and the frozen snapshot's `review-inventory.json` / `review-evidence.mjs`.
