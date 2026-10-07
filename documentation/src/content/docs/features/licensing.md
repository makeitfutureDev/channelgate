---
title: License keys and limits
description: Apply your organization license key and understand conversation limits, message counts, and offline behavior.
---

ChannelGate can run without a key, with a free organization key, or under an Enterprise agreement. License limits govern admitted engine work; provider API bills and model subscriptions remain separate.

## Set up a key

Create the organization's account on the ChannelGate platform, then open **Settings → License** in your installation. Enter its **License key**, save, and choose **Verify now**. The page shows the current tier, verification status, and per-conversation usage for this UTC month.

The operator can also bootstrap the key through `CHANNELGATE_LICENSE_KEY`. A value saved in admin settings takes precedence. Do not paste license keys into a public chat or repository.

Keys belong to the organization operating the installation. A service provider installing for a customer uses the customer's key; keys cannot be pooled or shared across organizations.

## Current limits

The published defaults are:

| State | Conversations | AI runs per conversation per UTC month |
| --- | --- | --- |
| No key | 1 | 500 |
| Free key | Unlimited | 500 |
| Enterprise key | Unlimited | Unlimited |

The issued key's verified limits are authoritative; limits may change under the published terms. Without a key, the first conversation admitted in a calendar month is the one served that month.

An AI message means an engine run started, including user tasks, follow-ups, scheduled runs, and background work. The gateway's memory-review runs are excluded. It warns at 80% of a monthly cap; at the cap it posts a visible refusal instead of spawning a run.

## Offline and privacy

The last verified tier remains valid for 14 days if verification cannot reach the platform. After grace expires, fallback applies at the start of the next UTC month, not midway through the month. Verification does not kill an already running task. Air-gapped deployments can use an issued signed offline payload.

License verification sends the key, installation ID, and software version. Usage reports send counts and hashed conversation IDs—not message text, files, user identities, or provider credentials.

Core confinement, permissions, memory, skills, standard chat connectors, and backup/restore are not weakened on the free tier. Managed updates and Composio SDK mode are optional Enterprise capabilities. Refer to the license itself for permitted use and commercial restrictions.

## Related guides

- [License reference](/docs/licensing)
- [Licensing FAQ](/docs/licensing/faq)
- [Privacy](/docs/privacy)
- [Usage and costs](/docs/features/usage-and-costs)
