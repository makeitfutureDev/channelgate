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

| State | Registered channels | Active conversations per channel per UTC month | AI runs per channel per UTC month |
| --- | --- | --- | --- |
| No key | Up to 10; one active channel per month | 100 in the active channel | 500 |
| Free key | Up to 10 | 100 in each channel | 500 |
| Enterprise key | Unlimited by default | Unlimited by default | Unlimited by default |

A conversation in the 100 allowance is an active **chat thread within a channel**, not an
individual AI run. Free installations also allow up to 10 stored human users. Every channel has
its own monthly thread allowance; repeated messages in an admitted thread reuse its slot. The
500-run monthly allowance is shared by the whole channel. Signed smaller limits are honored;
older Free keys cannot exceed these ceilings. Enterprise defaults to unlimited.

Without a key, the first active channel admitted in a UTC month is the one served that month.
Thread tracking starts with post-upgrade activity, without inventing earlier thread history;
old threads count when next used. Already admitted threads remain usable through a stricter
limit or downgrade for the rest of the month, subject to the channel's AI-run allowance. The
thread set resets at the next UTC month boundary.

An AI run includes user tasks, follow-ups, schedules and background work. Memory-review runs
are excluded. At a cap the gateway posts a visible refusal instead of spawning an engine; the
existing AI-run allowance warns at 80%.

## Offline and privacy

The last verified tier remains valid for 14 days if verification cannot reach the platform. After grace expires, fallback applies at the start of the next UTC month, not midway through the month. Verification does not kill an already running task. Air-gapped deployments can use an issued signed offline payload.

License verification sends the key, installation ID, and software version. Usage reports send counts and hashed conversation IDs—not message text, files, user identities, or provider credentials.

Core confinement, permissions, memory, skills, standard chat connectors, and backup/restore are not weakened on the free tier. Managed updates and Composio SDK mode are optional Enterprise capabilities. Refer to the license itself for permitted use and commercial restrictions.

## Related guides

- [License reference](/docs/licensing)
- [Licensing FAQ](/docs/licensing/faq)
- [Privacy](/docs/privacy)
- [Usage and costs](/docs/features/usage-and-costs)

## Cost-tracking history

Free installations (with or without a key) expose the most recent 30 days of cost-tracking history. Enterprise exposes unlimited history. This reporting window applies to audit records, summaries and dashboard totals, including external engine usage. Structured costs in audit events, HTTP run-job responses and schedule telemetry follow the same window; operational records and answer text remain available. It does not delete stored accounting, alter monthly AI allowances, or limit conversation history.


## Enterprise organization controls

The following capabilities require an effective Enterprise license (including use of previously
saved configuration after downgrade or expiry):

- Skill preferred-model switching: opt a conversation into honoring a skill's engine/model preference.
- Exact company email-domain auto-approval for new users and policy application to existing users.
- A dedicated Codex login per conversation, separate from the gateway login.
- The external skill-catalog MCP endpoint and its catalog/user access tokens.
- Organization environment variables shared across conversations.
- Google Drive workspace synchronization, both scheduled and on demand.
- Channel skill templates and their inherited skill grants.
- Per-channel monthly USD spending limits.

Other tiers retain ordinary skills, channel/personal environment variables, the shared gateway
Codex login, manual user approval and standard chat connectors. Stored Enterprise configuration
is preserved when an entitlement expires; it does not activate Enterprise behavior. A channel
configured with a dedicated Codex login is refused rather than silently switched to another account.

A spending limit is an admission control against the channel's recorded spend in the current UTC
calendar month. It is not a provider billing limit: an in-flight run can take recorded spend above
the cap, concurrent runs can overshoot, and provider-side costs are not reserved in advance.
`monthlySpendingLimitUSD: null` means no cap; a configured cap is a positive finite USD amount.
A current-month usage row with unknown cost refuses new runs until pricing is repaired or an
admin clears the cap. A saved cap also refuses new runs after downgrade; an admin can clear it
without Enterprise, so the safety control never silently disappears.
