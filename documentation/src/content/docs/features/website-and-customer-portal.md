---
title: Website and customer portal
description: Distinguish the public product website and portal from your self-hosted admin interface.
---

ChannelGate has separate public and self-hosted web surfaces. Knowing which one you are using prevents configuration changes from being made in the wrong place.

## Public website

[Channelgate.dev](https://channelgate.dev) hosts product information, the blog, and this public documentation. Documentation lives at `/docs` on the same existing Vercel website project and is built from Astro/Starlight content in the gateway repository.

The public handbook's pages explain product features and configuration; they are not connected to your local gateway database. Reading a guide does not change a conversation's settings or expose its files.

## Customer portal and licensing services

The public website/customer platform is a separate deployment and codebase from the self-hosted daemon. Platform services participate in license verification and supported customer-facing workflows. Product-site forms, account interfaces, lead routing, and platform services are managed in that separate project.

The published portal interface supports email sign-in links, choosing among linked organizations, viewing license keys and deployment usage, and reviewing account audit activity. Organization owners have controls to generate and revoke keys, rename the organization, and invite portal managers. A generated key is shown for copying once; the subsequent listing uses a masked prefix.

Use the public site's sign-in/register controls and the organization switcher before a customer action. Portal role restrictions and server-side account policies apply. These account flows belong to the separate customer platform; their presence in the published UI is not a claim that every backend action was exercised by this documentation build. A portal membership is distinct from a local gateway administrator or chat approval.

## Self-hosted admin interface

Your operator supplies the URL and password for the local [admin dashboard](/docs/features/admin-dashboard). By default it is served on port **4747** by the same process as the gateway. That is where you manage users, conversations, automations, skills, integrations, runtime settings, and local license state.

For example, to change a conversation model, use the local Conversations page or authorized chat control. To read how model defaults work, use this public handbook. To ask about a license/customer arrangement, follow the public website's support/customer route.

## Related guides

- [Admin dashboard](/docs/features/admin-dashboard)
- [Licensing](/docs/features/licensing)
- [Getting started](/docs/getting-started)
