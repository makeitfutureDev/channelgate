# Licensing FAQ — worked examples

Guidance for reading the [Makeitfuture Sustainable Use License](../LICENSE.md) (SUL), version
1.2. This file is **not part of the license**; where the two differ, `LICENSE.md` controls. It is
not legal advice. When a case is close, ask `contact@makeitfuture.com` before you deploy — a
written answer is free and much cheaper than the alternative.

## The one-line rule

**Running ChannelGate for yourself is free, within the limits of your key. Selling access to it is
not.**

Everything below is that sentence applied to specific situations. Section 3.1 adds the case the
one-liner does not settle — running a deployment *for someone else* — and Section 3.2 adds the
license key.

## The test that decides the hard cases

For a paid engagement, work through all five. The deployment is permitted service work under
Section 3, item (c)/3.1 only if every answer is on the left.

| | Permitted (§3.1) | Requires an agreement (§4) |
|---|---|---|
| **Who does the deployment serve?** | One customer and its organization | Two or more customers, or shared/multi-tenant |
| **Who can walk away with it?** | The customer holds or can obtain the config, credentials, key, and data, and can migrate without asking anyone | You retain control; the customer cannot leave with a working deployment |
| **What is the fee for?** | Your labor, hosting cost, support, development | Access to, or a seat in, the Software itself |
| **Whose product is it?** | ChannelGate, deployed for the customer; notices and branding intact | Your branded product or subscription |
| **Whose key?** | The customer's own key, from the customer's own account | Your key, shared across customers |

Failing any one of them moves the deployment under Section 4.

## Worked examples

### ✅ Permitted without an agreement

**A company runs it for its own team.** Any size, any number of channels with a free key, modified
however they like. This is the core §3.1 grant. Without a key it serves one conversation — enough
to evaluate.

**A company modifies it heavily and never publishes the changes.** No copyleft, no publication
duty. The SUL is not AGPL.

**An agency installs and configures it for a client, then hands over the keys.** Classic §3, item (c)
consulting. Bill whatever the work is worth. The client creates the platform account; the agency
can be added as a manager.

**An agency keeps operating it for that one client — on the client's server or on a box the agency
rents for them — and bills a monthly retainer.** Permitted under §3.1, provided the deployment is
that client's alone, the client can take it over, the fee is for the service, it is not sold as the
agency's own product, and it runs on the client's key.

**An agency does the above for twenty clients.** Permitted — §3.1 applies to each deployment
separately, and no agreement is needed for any number of them. A Partner Agreement exists for
listing, co-marketing, and priority support; it is optional.

**A contractor builds custom skills, MCP servers, or channel automations on top of it for a
client** and charges for that development. Permitted.

**Someone runs it for a nonprofit, a school, or a personal Slack.** Noncommercial use, §3.2.

**Someone forks it, renames their fork on GitHub, and gives it away for free.** Permitted under
§3, item (d) as long as the license and notices ride along, the modification is disclosed (§5), the fork
does not present itself as ChannelGate (`TRADEMARK.md`), and the license-key checks stay in place
(§4.5).

### ❌ Requires a written agreement

**A hosted "ChannelGate as a service" with signups and a monthly plan.** §4.2 — the textbook case
the license exists for.

**One deployment serving several client workspaces, billed per client.** §4.2 — multi-tenancy is
the line, even when each client is otherwise happy. Give each client their own deployment on their
own key and the same business is fine under §3.1.

**An agency puts its own key into every client's deployment.** §3.2/§4.5 — a key belongs to one
organization. Each client creates its own account; the agency manages it.

**An agency sells "AgencyBot — your AI teammate in Slack, €500/month", and it is ChannelGate with
a new logo.** §4.4 and §5 — de-branding and reselling. This is exactly the deal we want to do; it
needs a White-Label Agreement, not silence.

**A SaaS product whose main feature is a Slack AI agent, built on ChannelGate.** §4.3 — the
product's value derives substantially from it. The test: would the product still be sold without
the Gateway inside it?

**Reselling it, bundling it into a paid software package, charging a per-seat license fee for it,
or selling license keys.** §4.1 — a Reseller Agreement covers this.

**Charging a client for "platform access" rather than for services, even with one deployment per
client.** Fails the third column of the test — the fee is for the Software.

**Patching out the key check or the monthly limit.** §4.5. The code is visible on purpose; the
license is the enforcement.

### 🟡 Ask first

- The customer wants the agency to keep exclusive control of the credentials and deployment for
  compliance reasons. This dents §3.1.2 but is often solvable — write to us.
- An internal platform team offering ChannelGate to other legal entities in a group of companies.
  Usually fine under the *your organization* definition (common control), but confirm the
  ownership chain — and which entity holds the key.
- Public-sector or regulated deployments needing modified warranty or indemnity terms. The public
  license disclaims both; an Enterprise License can change that.

## License keys

**Why is there a key at all?** Two reasons: the free tier has to be sustainable, and the key is
how a self-hosted install and Makeitfuture know about each other. Everything security-related
works identically with or without a key.

**What does a free key cost?** Nothing. Create an account with your email on the ChannelGate
platform and the key is issued immediately; it unlocks unlimited conversations at 500 AI messages
per conversation per month. Tiers and definitions: [`LICENSE-KEYS.md`](LICENSE-KEYS.md).

**What does licensing transmit?** Verification sends the raw license key, installation id and
version over HTTPS. Usage reports send a key hash and hashed conversation ids with counts.
Licensing does not send message content or provider credentials. Separately, model and connector
providers receive the context and tool requests needed for enabled features. Hashes are
pseudonymous identifiers, not guaranteed anonymity. See
[`PRIVACY-AND-DATA-FLOW.md`](PRIVACY-AND-DATA-FLOW.md).

**What if the platform is down or my server is offline?** The last verified tier stays valid for
14 days with a banner; after that the deployment falls back to no-key limits at the next month
boundary. Nothing crashes and no run is killed.

**Can the limits change?** Yes, for future versions and for keys issued after a change; the limits
of an enterprise key are fixed for its term. Changes are announced in `CHANGELOG.md`.

## Other questions

**Is this open source?** No. It is **source-available** / **fair-code**. Call it that. Calling it
open source misrepresents it and is a licensing risk, not a marketing preference.

**Will it become open source?** There is no automatic relicensing. Version 1.1 carried a delayed
Apache-2.0 grant; version 1.2 removed it before the first publication, so no published version
converts on a schedule. The Licensor decides the terms of every release.

**Do I have to publish my modifications?** No. Only a *distributed* modified copy must say it was
modified and when (§5). Internal changes stay yours.

**Can I contribute?** Yes — sign off your commits per [`CLA.md`](../CLA.md). You keep your
copyright; the Licensor gets the right to relicense so commercial licenses and the enterprise
edition remain possible.

**What about the dependencies and fonts?** They keep their own licenses; see
`THIRD_PARTY_NOTICES.md`. The bundled Poppins fonts are SIL OFL 1.1.

**Does the license restrict which AI models or MCP servers I use?** No. Those are your agreements
with Anthropic, OpenAI, Composio, and anyone else. The SUL governs ChannelGate's code only.

**Which law applies?** Romanian law, courts of Bucharest (§11).

## What will never be behind a paid tier

The license splits by *use case* and by *usage volume* (the key). The enterprise edition in
`src/ee/` splits by *feature*. These lines commit that split in advance:

**Never paid, in any tier:** the per-conversation sandbox (a container per channel) and filesystem
confinement, secret handling and storage, the authorization model, the MCP allowlist, the audit
event record, and backup/restore. Confinement is the product; a free tier with weaker isolation
would make the security claim meaningless and is off the table permanently. Usage limits cap *how
much* you run, never *how safely*.

**Fair game for the enterprise edition:** SSO/SAML/OIDC/SCIM, multi-admin RBAC, audit-log *export*
and SIEM streaming, org-wide identity provisioning, multi-workspace operation, budgets and
chargeback reporting, and white-labeling. Standard chat connectors remain free; Microsoft Teams and Google Chat are **Beta**.
Composio SDK mode is an **Enterprise-only Beta**; standard Composio MCP mode remains available
in every tier.

Core security is not a feature tier. Optional Enterprise integrations are listed explicitly,
so an integration being useful to one team does not imply it is included in the free tier.

**Can a no-key install include the EE directory?** Yes. Its license expressly permits unchanged
bundled enforcement code in every otherwise permitted install and distribution. Enterprise
feature use still requires the corresponding entitlement; see [the EE terms](../src/ee/LICENSE-EE.md).
