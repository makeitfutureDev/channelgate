# Licensing decision record

Decision date: 2026-08-06

Authorized owner/approver: Tiberiu Socaci

Effective version: 1.0.0 and later unless a file states another license

ChannelGate uses the **Makeitfuture Sustainable Use License, Version 1.0**, a source-available
fair-code license modeled on n8n's Sustainable Use License. The owner selected this model to keep
self-hosting and modification for an organization's own internal operations, personal and
noncommercial use, and paid consulting, support, and integration for a customer's permitted
internal deployment available while protecting the hosted commercial product.

The license requires a separate written commercial agreement for paid hosting, white-labeling,
resale, or a product/service whose value derives substantially from ChannelGate. Free
noncommercial redistribution is allowed with the license and notices intact. The project must be
described as **source-available** or **fair-code**, never as OSI open source.

Bundled Poppins font binaries remain under the SIL Open Font License 1.1; their copyright and full
license are shipped beside the files. Other third-party components retain their upstream licenses.

This decision resolves the license-selection gate. It does not authorize public export of the
current history or waive credential rotation, company/client-data scrubbing, contributor/IP review,
trademark review, independent security review, or the live release canaries. Counsel should review
the license text and ownership chain before a public launch.

---

## Amendment: version 1.1

Decision date: 2026-08-20

Authorized owner/approver: Tiberiu Socaci

Requested in #gateway-slack as a review of our terms against cal.com's open-core model, with the
question of separating some features into an enterprise tier. Five changes were approved; three
are licensing text and shipped here, two are engineering work tracked on the internal roadmap.

### What changed in `LICENSE.md`

1. **Dedicated deployments operated for a customer (new §3.1).** Version 1.0 allowed paid
   consulting for a customer's internal deployment (§3.3) while forbidding the Software as "a
   material feature of a paid product or service" (§4.3). An agency that installs, tunes, and then
   *operates* a Gateway for one client sat in both, and Makeitfuture is itself an agency — the
   ambiguity landed on our own core business and on our most likely partner channel. §3.1 now
   states the four conditions that keep operated deployments on the permitted side: one customer
   per deployment, customer can take it over, fees are for services rather than for access, and it
   is not sold as the operator's own product. §4.2 gained the matching "shared by or offered to
   more than one customer" clause, so the multi-tenancy line is explicit rather than inferred.
   *Internal business operations* is now a defined term (§12).

2. **White-labeling and de-branding (new §4.4, expanded §5).** Rebranding was implied by the
   trademark language but never prohibited outright, while white-label licensing is a product we
   intend to sell. §4.4 forbids removing or obscuring the Software's names and attribution to
   present it as another party's product, and §5 extends notice preservation to product branding
   in user interfaces and documentation.

3. **Contributions and the CLA (new §6, new `CLA.md`).** The project has no inbound contribution
   terms and a public source-available export is planned. Without inbound-equals-outbound clarity
   plus an explicit relicensing grant, a single outside patch would block both commercial
   licensing and the Change Date grant for the file it touches. `CLA.md` uses a DCO-style
   `Signed-off-by` sign-off, leaves copyright with the contributor, and grants Makeitfuture the
   right to relicense. This is cheap now and effectively unfixable after a public launch; it is a
   hard gate on the export.

4. **Change Date (new §7).** Each published version additionally becomes available under
   Apache-2.0 on the fourth anniversary of its publication, irrevocably, with the dates recorded in
   `CHANGELOG.md`. §10 confirms termination cannot withdraw a grant that has already vested.

### Why we did not copy cal.com's structure

Cal.com ran the canonical open-core split: AGPLv3 core, a `/ee` directory under a subscription
license enforced by a license key, and the rule "singleplayer features open, multiplayer features
commercial." On **2026-04-15** they abandoned it — the commercial codebase moved to a private
repository and the public repository became `calcom/cal.diy`, an MIT community fork with the
enterprise features stripped, positioned for personal, non-production use. The stated reason was
AI-driven security risk.

The transferable lesson is not the stated reason; it is that an open-core boundary erodes once the
commercial features carry the revenue, and unwinding it costs credibility that a security-
positioned product cannot spend. The Sustainable Use License does not have that failure mode: we
never claimed OSI open source, so we can never be accused of withdrawing it. The response is
therefore to keep the SUL as the single license and adopt cal.com's *rule* (single-team free,
multi-team commercial) rather than their *structure* (split repository, copyleft core). Section 7's
Change Date is the deliberate counter-signal to the "they will pull a cal.com" objection every
self-hoster now raises by default.

### Enterprise-tier boundary (policy, ahead of the code)

Recorded here so the boundary is a decision rather than an accumulation of choices. Full list in
`LICENSING-FAQ.md`.

- **Never behind a paid tier, permanently:** the per-conversation sandbox (a container per
  channel) and filesystem confinement, secret handling, the authorization model, the MCP
  allowlist, the audit event
  record, and backup/restore. `AGENTS.md` states confinement is the product; a free tier with
  weaker isolation would void the security claim and lose the audience the license is written for.
- **Eligible for an enterprise tier:** SSO/SAML/OIDC/SCIM, multi-admin RBAC, audit-log export and
  SIEM streaming, org-wide identity provisioning, multi-workspace operation, budgets and chargeback
  reporting, white-labeling, and additional chat platforms.

Implementation — a licensed `src/ee/` boundary with a key gate — is an internal-roadmap slice and is
explicitly **not** shipped by this amendment. No feature currently in the free tier will be moved
behind a key; the enterprise tier may only contain code written for it.

### Unchanged

The license remains source-available/fair-code, must never be described as OSI open source, and
the public-export gates from the 1.0 record stand in full: credential rotation, company/client-data
scrubbing, contributor/IP review, trademark review, independent security review, and the live
release canaries. Counsel should review the 1.1 text — particularly §3.1, §6, and §7 — and the
ownership chain before a public launch. The Change Date in §7 is a durable commitment: it can be
shortened but not extended for a version already published, so counsel review must precede the
first public release, not follow it.

---

## Amendment: version 1.2

Decision date: 2026-08-25

Authorized owner/approver: Tiberiu Socaci

Requested in #gateway-slack while preparing the public release. Seven decisions were taken one by
one and are recorded in the public-release plan (`channelgate-internal` repo, `docs/plans/2026-08-25-public-release-plan.md`; D1–D7); the licensing
consequences ship here as text. Counsel review of the 1.2 text remains the release gate.

### Ownership chain

The software was authored by Tiberiu Socaci; the intellectual property is held by MAKEITFUTURE
S.R.L. under a written IP assignment between the author and the company (`AUTHORS.md`). Every
commit to date is the author's (the sole external commits are Dependabot's); this record is the
acceptance of `CLA.md` for all pre-CLA contributions.

### What changed in `LICENSE.md`

1. **Name.** The Software is ChannelGate (D1). The former USPTO registration of "CHANNEL GATE"
   (Cymax Stores Inc., class 42) was cancelled on 2025-07-11; Cymax still trades under the name,
   so CIPO/EUIPO clearance by counsel precedes any public use of the mark. `TRADEMARK.md` states
   nominative-use permissions and the white-label boundary.
2. **Change Date removed (D3).** The former §7 vested an irrevocable Apache-2.0 grant four years
   after each publication and could not be extended afterwards. The owner's decision is that no
   version is relicensed automatically, ever; the Licensor decides the terms of each release. The
   §6, §10 and `CLA.md` references to the grant were removed with it. The 1.1 rationale — a
   counter-signal to the cal.com objection — is retired in favour of plain control; the FAQ says so
   openly rather than hiding the change.
3. **License keys and usage limits (new §3.2, §4.5, §12; D4, D6).** Without a key the Software
   serves one conversation; a free key (account by email on the ChannelGate platform) unlocks
   unlimited conversations at 500 AI messages per conversation per month; an enterprise key is
   unlimited. Keys are **end-user keys only**: issued to the organization operating the deployment,
   never shared or pooled by a service provider. Circumventing the check is a violation — the code
   is visible, the license enforces. Tiers and definitions live in `docs/LICENSE-KEYS.md` so limits
   can change without amending the license.
4. **Per-deployment service work (§3.1).** A provider may operate any number of separate
   single-customer deployments without an agreement; the customer's key is a fifth condition.
   The FAQ's "MSP at scale → ask first" became "permitted per deployment; Partner Agreement
   optional".
5. **Named agreements (§4).** Reseller, White-Label, Enterprise License, and the optional Partner
   Agreement, so sales and the FAQ point at the same names.
6. **Governing law and venue (new §11).** Romanian law, courts of Bucharest — counsel to confirm.

### Enterprise-tier boundary — amended

The 1.1 rule "no feature currently in the free tier moves behind a key" is amended **before any
publication**, which is the only moment this is possible without breaking a promise: multi-
conversation operation and message volume become key-gated *usage limits*. The security list
("never paid, in any tier") is unchanged and now explicitly includes the statement that limits cap
how much you run, never how safely. Slack, Microsoft Teams, and Google Chat are free; the
enterprise edition (`src/ee/`, proprietary, source-visible, built before launch per D4) may
contain SSO/SCIM, RBAC, audit export/SIEM, provisioning, multi-workspace, budgets, and
white-labeling.

### Unchanged

Source-available/fair-code, never described as OSI open source. The public-export gates stand:
credential rotation, company/client-data scrubbing, contributor/IP review, trademark review (now
concrete: CIPO/EUIPO on "ChannelGate"), independent security review, and the live release
canaries.
