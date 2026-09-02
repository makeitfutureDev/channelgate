# ChannelGate — licensing in one page

A shareable plain-language summary of the
[Makeitfuture Sustainable Use License v1.2](../LICENSE.md). The license itself is the binding
document; this page is a guide, and it is not legal advice. Questions:
`contact@makeitfuture.com`.

## The short version

**Running ChannelGate for yourself is free, within the limits of your key. Selling access to it is
not.**

ChannelGate (formerly Claude Gateway for Slack) is **source-available** software under the
Makeitfuture Sustainable Use License, a fair-code license modeled on n8n's. You get the full
source, you can read it, run it, change it, and self-host it — for your own organization, at no
cost, with a free key. What needs an agreement with Makeitfuture is turning it into a product you
sell.

It is **not** OSI-approved open source, and we never describe it that way. No version is
relicensed automatically.

## Keys and limits

| | Conversations | AI messages per conversation per month |
| --- | --- | --- |
| **No key** — install and run | 1 | 500 |
| **Free key** — create an account with your email | unlimited | 500 |
| **Enterprise key** — agreement with Makeitfuture | unlimited | unlimited |

A key belongs to the organization that runs the deployment. Agencies use their client's key, never
their own across clients. Security features are identical in every tier. Details, definitions, and
what the deployment reports: [`LICENSE-KEYS.md`](LICENSE-KEYS.md).

## What you can do for free

- **Run it for your own company.** Any team size, any number of channels with a free key, on your
  own infrastructure — Slack, Microsoft Teams, or Google Chat.
- **Modify it however you like.** No obligation to publish your changes — this is not AGPL, there
  is no copyleft.
- **Use it personally, or for a nonprofit, school, or charity.**
- **Pay someone to help.** Consultants and agencies may charge to install, configure, integrate,
  support, or develop against it.
- **Operate it for clients as a service.** An agency can host and administer a client's
  deployment and bill a retainer, for any number of clients, as long as each deployment belongs to
  that client and runs on that client's key (see below).
- **Give it away.** Redistribute the original or a modified copy for free, with the license,
  notices, and key checks intact, and say what you changed.

## What needs an agreement with us

- Hosting it as a paid product or SaaS, with signups or subscription plans — *Enterprise License*.
- One deployment serving several customers — multi-tenancy is the line — *Enterprise License*.
- White-labeling: rebranding it as your own or a client's product — *White-Label Agreement*.
- Reselling it, its license keys, bundling it into paid software, or charging a per-seat fee for
  it — *Reseller Agreement*.
- Building a commercial product whose value comes substantially from ChannelGate.
- Patching out the key check or the limits. The code is visible; the license is the enforcement.

None of these is a "no". They are the conversations we want to have. Write to
`contact@makeitfuture.com`. Agencies that simply operate dedicated deployments need no agreement;
an optional *Partner Agreement* adds listing, co-marketing, and priority support.

## The agency question, answered

The common case deserves a direct answer, because most fair-code licenses leave it vague.

**You may operate a deployment for a client and charge for it**, provided all five are true:

1. **One customer per deployment.** Not shared or multi-tenanted across clients.
2. **The client can leave.** They hold or can obtain the configuration, credentials, key, and
   data, and can take the deployment over or migrate it without anyone's permission.
3. **The fee is for your work** — setup, hosting costs, administration, support, development — not
   for access to the software or a seat in it.
4. **It is still ChannelGate.** Not rebranded and sold as your own product; notices and branding
   intact.
5. **It runs on the client's key.** The client creates the account; you can be added as a manager.

Fail any one and that deployment moves into commercial-agreement territory. Each deployment is
judged on its own, so twenty clients on twenty dedicated deployments are fine.

## Security is never a paid tier

These stay free in every tier, permanently: the per-conversation sandbox and filesystem
confinement, secret handling, the authorization model, the MCP allowlist, the audit event record,
and backup/restore. Usage limits cap how much you run, never how safely.

Confinement is the product. A free tier with weaker isolation would make the security claim
meaningless, so it is off the table — not "not planned", but excluded by policy. The rule for the
enterprise edition (`src/ee/`) is that **single-team features stay free and multi-team or
multi-tenant features are commercial**; security is not a feature tier.

## Contributing

Contributions are welcome under [`CLA.md`](../CLA.md): add a `Signed-off-by` trailer to your
commits (`git commit -s`). You keep the copyright in your work and may use it however you like
elsewhere. The agreement gives Makeitfuture the right to relicense contributions, which is what
makes commercial licenses and the enterprise edition possible.

## Trademark

ChannelGate is a trademark of MAKEITFUTURE S.R.L. You may say you install, host, support, or build
on ChannelGate; you may not use the name for your own product, company, or domain, or present a
modified copy as ChannelGate. Details in [`TRADEMARK.md`](../TRADEMARK.md).

## Third-party components

Dependencies keep their own licenses (recorded in `package-lock.json`), and the bundled Poppins
fonts remain under the SIL Open Font License 1.1. Details in `THIRD_PARTY_NOTICES.md`. The
Sustainable Use License does not replace those terms.

The license also says nothing about which AI models or MCP servers you use — those are your own
agreements with Anthropic, OpenAI, Composio, and anyone else.

## Where to read more

| Document | What it is |
| --- | --- |
| [`LICENSE.md`](../LICENSE.md) | The binding license text (v1.2) |
| [`LICENSE-KEYS.md`](LICENSE-KEYS.md) | Tiers, limits, definitions, what the deployment reports |
| [`CLA.md`](../CLA.md) | Contributor terms |
| [`TRADEMARK.md`](../TRADEMARK.md) | What you may call it |
| [`LICENSING-FAQ.md`](LICENSING-FAQ.md) | Worked ✅ / ❌ / 🟡 examples for specific situations |
| [`LICENSING-DECISION.md`](LICENSING-DECISION.md) | Why these terms, and the decision record |
