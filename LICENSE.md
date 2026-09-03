# Makeitfuture Sustainable Use License

Version 1.2

Copyright © 2026 MAKEITFUTURE S.R.L. All rights reserved.
Original author: Tiberiu Socaci — see `AUTHORS.md`.

This license applies to ChannelGate (formerly "Claude Gateway for Slack") source code and other
materials in this repository unless a file or directory identifies different terms. The enterprise
directory `src/ee/` is licensed separately under the terms stated in that directory. Third-party
components, including the bundled Poppins fonts, remain governed by their respective licenses
described in `THIRD_PARTY_NOTICES.md`.

Worked examples of how Sections 3 and 4 apply to real deployments — in particular agency,
managed-service, and reseller scenarios — are in [`docs/LICENSING-FAQ.md`](docs/LICENSING-FAQ.md).
The license-key tiers and usage limits referenced in Section 3.2 are described in
[`docs/LICENSE-KEYS.md`](docs/LICENSE-KEYS.md). Trademark guidance is in
[`TRADEMARK.md`](TRADEMARK.md). The FAQ and the trademark guidance are not part of this license;
where they differ from it, this license controls.

## 1. Acceptance

By exercising any permission granted below, you accept this license.

## 2. License grant

MAKEITFUTURE S.R.L. (the **Licensor**) grants you a worldwide, royalty-free, non-exclusive,
non-transferable, and non-sublicensable right to use, reproduce, modify, distribute, make
available, and create derivative works of ChannelGate (the **Software**), subject to this license.

## 3. Permitted use

Subject to Section 3.2, you may:

1. use and modify the Software for your own internal business operations;
2. use and modify the Software for personal, educational, charitable, or other noncommercial
   purposes;
3. provide consulting, integration, support, installation, maintenance, or operation services for
   a single organization's permitted internal deployment, including a deployment you host or
   administer on that organization's behalf, provided the conditions in Section 3.1 are met; and
4. distribute original or modified copies without charge solely for noncommercial purposes,
   provided every recipient receives this license and all required notices.

### 3.1 Dedicated deployments operated on a customer's behalf

A deployment you operate for a customer stays within Section 3.3 only while all of the following
remain true:

1. the deployment serves that one customer and its organization — it is not shared with, or
   multi-tenanted across, other customers;
2. the customer controls or can obtain the deployment's configuration, credentials, license key,
   and data, and can take over or migrate the deployment without the Licensor's or your permission;
3. your fees are charged for your services (setup, hosting cost pass-through, administration,
   support, or development), not for access to, or a right to use, the Software itself;
4. the deployment is not marketed, branded, or sold as your own product or as a subscription
   product, and the Software's notices and branding are preserved as required by Section 5; and
5. any license key used by the deployment was issued to that customer under Section 3.2.

These conditions apply to each deployment separately. You may operate any number of separate
deployments for different customers under this section without an agreement with the Licensor.
If any condition stops being true for a deployment, that deployment falls under Section 4 and
requires a separate written agreement.

### 3.2 License keys and usage limits

The Software enforces usage limits that depend on a **license key**. Without a key, the Software
serves a single conversation. A key is issued by the Licensor, through its platform, to the
organization that operates a deployment (an **end-user key**), and determines the number of
conversations and the monthly volume of AI messages available to that organization. The tiers
and limits current for a version are described in `docs/LICENSE-KEYS.md`; the Licensor may set
different limits for future versions and for keys it issues, and will not reduce the limits of an
enterprise key during its agreed term.

A license key identifies one organization. You may not share, pool, transfer, or resell a key, or
use a key issued to one organization to operate a deployment for another. A service provider
acting under Section 3.1 uses the customer's own key. You may not remove, disable, bypass, or
circumvent key verification, usage limits, or usage reporting, or misrepresent usage to the
Licensor.

## 4. Commercial restrictions

Without a separate written agreement from the Licensor, you may not:

1. sell, resell, sublicense, or otherwise distribute the Software for a fee;
2. offer the Software or a modified version as a paid hosted, managed, white-label, or
   software-as-a-service product, including any deployment shared by or offered to more than one
   customer;
3. make the Software available to third parties as a material feature of a paid product or service
   where the product's value derives substantially from ChannelGate;
4. remove, replace, or obscure the Software's names, marks, or attribution in order to present it
   as your own or another party's product; or
5. circumvent or disable license-key verification, usage limits, or usage reporting, or share,
   pool, or transfer a license key across organizations.

These restrictions do not prohibit charging for the services described in Sections 3.3 and 3.1,
provided the customer uses the Software only for its own permitted internal operations.

The Licensor offers written agreements for uses outside this license: a **Reseller Agreement**
(distributing the Software or its license keys for a fee), a **White-Label Agreement** (rebranding
the Software or presenting it as another party's product), an **Enterprise License** (uses and
limits beyond the public tiers, including paid hosting and multi-tenant operation), and an
optional **Partner Agreement** for service providers that operate dedicated deployments under
Section 3.1 and want listing, co-marketing, or priority support — operating such deployments does
not itself require any agreement. Contact `contact@makeitfuture.com`.

## 5. Notices, branding, and modifications

You must preserve all copyright, attribution, trademark, and license notices, including the
Software's name and product branding as presented in its user interfaces and documentation. A
distributed modified copy must prominently state that it was modified and identify the
modification date. You may not imply endorsement by the Licensor or use its trademarks except as
allowed by law, by `TRADEMARK.md`, or by a separate written agreement. Rebranding or white-labeling
the Software requires a separate written agreement; this license grants no trademark rights.

## 6. Contributions

Unless you state otherwise in writing at the time of submission, any contribution you
intentionally submit for inclusion in the Software is provided under this license, and you grant
the Licensor the additional rights described in [`CLA.md`](CLA.md) — including the right to
license your contribution under other terms, such as a commercial license or the separately
licensed enterprise edition. The Licensor may require a signed or recorded acceptance of `CLA.md`
before merging a contribution. This section grants no rights in your contribution to anyone other
than the Licensor and recipients of the Software under this license.

## 7. Patents

The Licensor grants you a patent license, limited to patent claims it can license that are
necessarily infringed by permitted use of the unmodified Software. The patent license does not
cover claims introduced by your modifications or combinations. It ends immediately if you or your
organization assert in writing that the Software infringes a patent.

## 8. Ownership and other rights

The Software is licensed, not sold. The Licensor and applicable contributors retain all rights not
expressly granted. This license does not grant rights to the Licensor's names, logos, or trademarks.
Nothing in this license obliges the Licensor to publish future versions, to accept contributions,
or to make any version available under other terms.

## 9. Termination and cure

Your rights terminate automatically when you violate this license. For a first violation, they are
reinstated retroactively if you stop the violation and remedy its effects within 30 days after
receiving written notice from the Licensor. A later violation after reinstatement terminates your
rights permanently unless the Licensor agrees otherwise in writing. The Licensor may also revoke a
license key issued to you for a violation of Section 3.2 or 4.5.

## 10. Disclaimer and limitation of liability

To the maximum extent permitted by law, the Software is provided **as is**, without warranties or
conditions of any kind, including merchantability, fitness for a particular purpose, title, or
noninfringement. The Licensor and contributors are not liable for any direct, indirect, incidental,
special, exemplary, or consequential loss arising from the Software or this license.

## 11. Governing law and venue

This license is governed by the laws of Romania, excluding its conflict-of-law rules. The courts
of Bucharest, Romania, have exclusive jurisdiction over any dispute arising from it, without
prejudice to mandatory protections that apply to you as a consumer in your country of residence.

## 12. Definitions

**You** means the person or legal entity accepting this license. **Your organization** includes
entities that control, are controlled by, or are under common control with you. **Control** means
the power to direct management or policies, whether by ownership, contract, or otherwise.
**Internal business operations** means use by you and your organization, and by your own workers
and contractors acting for you, for your own purposes — not the provision of the Software's
functionality to your customers as a product or service. **Noncommercial** means activity not
primarily intended for commercial advantage or monetary compensation. **Distribute** includes
providing a copy or making the Software available to another person or entity. **Contribution**
means any work of authorship you intentionally submit to the Licensor for inclusion in the
Software. **License key** means a credential the Licensor issues through its platform that
identifies the organization operating a deployment and the limits that apply to it.
**Conversation** means a distinct channel, group, or direct-message thread on a supported chat
platform, as identified by the Software.

## 13. Version history

- **1.2** (2026-08-25) — renamed the Software to ChannelGate; added license keys and usage limits
  (3.2, 4.5, 12) with end-user keys only; made per-deployment service work under 3.1 explicit for
  any number of customers; named the commercial agreements (4); removed the former Section 7
  Change Date — no version is relicensed automatically; added governing law and venue (11);
  moved trademark guidance to `TRADEMARK.md`.
- **1.1** (2026-08-20) — clarified that operating a dedicated deployment for a single customer is
  permitted service work and defined its conditions (3.1); defined *internal business operations*;
  made white-labeling and de-branding an explicit restriction (4.4, 5); added contribution terms
  (6) and a Change Date grant (since removed in 1.2).
- **1.0** (2026-08-06) — initial release.

This is a source-available fair-code license with commercial-use restrictions. It is not an
Open Source Initiative approved open-source license.
