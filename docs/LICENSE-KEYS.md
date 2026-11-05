# License keys, tiers, and usage limits

Referenced by Section 3.2 of [`LICENSE.md`](../LICENSE.md). This page describes the tiers and
limits that apply to the current version; the Licensor may set different limits for future
versions and for the keys it issues. Limits are delivered to a deployment by the ChannelGate
platform, so they can change without a new release; the limits that apply to an enterprise key
are fixed for its agreed term.

## Tiers

| Tier | How you get it | Registered channels | Registered users | Active chat threads per channel per UTC month | AI runs per channel per UTC month |
| --- | --- | --- | --- | --- | --- |
| **No key** | install and run | 10 (one active channel per month) | 10 | 100 in the active channel | 500 |
| **Registered (free key)** | create an account with your email on the ChannelGate platform | 10 | 10 | 100 in each channel | 500 |
| **Enterprise key** | Enterprise License with Makeitfuture | unlimited by default | unlimited by default | unlimited by default | unlimited by default |

## Definitions

- A **channel** is a persistent channel, group or direct-message record on a supported chat
  platform. A **conversation** for the 100 allowance is an active chat thread within that channel,
  not another channel and not an individual AI message. Each channel has its own UTC-month
  allowance. Repeated messages and automation in the same admitted thread reuse its slot.
- **Registered channels** include DMs, groups and the synthetic API conversation. **Registered
  users** are all stored human account records, including unapproved users; the synthetic API
  principal is excluded. Inventory counts do not reset monthly. Non-Enterprise deployments
  cannot create an 11th record of either kind. Existing records remain editable and usable after
  an upgrade or downgrade; growth is refused until below the cap, and other limits still apply.
- Free installations allow 100 active threads **per channel per UTC month**, 10 channels and 10
  users. Legacy or newly signed Free payloads cannot raise these compiled ceilings by omitting
  fields, supplying `null`, or granting larger values. Signed smaller caps are honored.
  Enterprise defaults to unlimited and may carry agreed limits.
- Without a key, the first active channel admitted in a UTC month remains the one served that
  month; its thread allowance is 100. A registered Free key allows activity in its registered
  channels, each with its own 100-thread allowance.
- Threads already admitted before a stricter limit or Enterprise downgrade remain usable for
  that UTC month. New threads are refused once their channel's allowance is reached. The set
  resets at the next UTC month boundary; admitted threads still obey the AI-run allowance.
- An **AI run** is one engine run started for a channel. User turns, follow-ups, schedules and
  background jobs share the existing 500-run allowance per channel per UTC month. Memory-review
  runs are excluded. The 100-thread allowance does not grant 500 runs to each thread.
- Thread tracking begins with post-upgrade activity. The upgrade does not fabricate past thread
  history: an old thread counts when it is next used, and existing channel AI-run counts remain.
- At a monthly limit the assistant answers with a short notice instead of starting a run. The
  existing AI-run allowance warns once at 80 %.

Standalone automation fires without an existing chat thread use a stable logical conversation identity for that fire. Once a delivery thread is known, later runs in that thread share its slot. Background agents and question continuations in an existing conversation keep the parent conversation identity even when their engine sessions are isolated.

## Whose key

A key belongs to the **organization that operates the deployment** — an end-user key. An agency or
service provider that installs or operates ChannelGate for a customer under Section 3.1 uses the
customer's key: the customer creates the account with its own email and may add the provider as a
manager. Keys are never shared, pooled, or transferred across organizations.

## What the deployment sends to the platform

Key verification runs at start-up and about once a day; usage is reported as counts. The payload
for verification contains the raw license key, installation id and software version. Usage
reports contain a key hash and per-conversation **hashed** ids with message counts. Licensing
payloads never contain message content, user identities, channel names, provider credentials or
files. The stable hashes are pseudonymous, not guaranteed anonymous. The full data-flow description is in
[`PRIVACY-AND-DATA-FLOW.md`](PRIVACY-AND-DATA-FLOW.md).

## Offline behaviour

A deployment that cannot reach the platform keeps its last verified tier for **14 days** and shows
a banner in the admin UI. After the grace period it falls back to the no-key limits at the start of
the next calendar month — never mid-month, never silently. An unlicensed or unreachable state is a
healthy state: the daemon keeps running and no run is ever killed by the license check.

## Changing the limits

The Licensor may raise or lower the no-key and free-key limits for future versions and for keys
it issues after the change; changes are announced in `CHANGELOG.md`.

## Where the code lives

License verification and enforcement live in **`src/ee/`**. That directory is **proprietary,
source-visible** code owned by MAKEITFUTURE S.R.L. — it is deliberately readable so that an
operator can audit exactly what the check does and what leaves the install, but it is **not**
covered by the Sustainable Use License in `LICENSE.md`. Its own terms are in
[`src/ee/LICENSE-EE.md`](../src/ee/LICENSE-EE.md), and Sections 3.2 and 4.5 of `LICENSE.md` make
removing, disabling, or circumventing what it implements a licence violation.

| File | What it is |
| --- | --- |
| `src/ee/LICENSE-EE.md` | the terms for the directory |
| `src/ee/tiers.js` | the platform URL, the compiled-in no-key limits, the canonical JSON the signature covers |
| `src/ee/license-public-key.js` | the Ed25519 public key every license payload is verified against |
| `src/ee/license.js` | key storage, installation id, verification, the state machine |
| `src/ee/limits.js` | conversation admission, the monthly cap, the usage report |

Inventory admission is checked atomically inside the user/channel store transactions before new
records are written. `licenseAdmission()` is called by the run orchestrator
(`src/gateway/run.js`) before a turn provisions a folder, mints a session, or spawns an engine. A
refused turn is a short reply, never an error and never silence.

## Setting a key

Any one of these; the first that is set wins.

1. **Admin UI** — Settings → License → *License key*, then *Verify now*. The value is stored in
   `settings.json`, never returned by a listing (only `hasLicenseKey` and the last four
   characters), and can be read back one at a time through the same password-protected reveal as
   every other secret.
2. **Chat** — an admin can use the `set_license_key` gateway tool (and `clear_license_key`).
   Both need a human Approve click; `get_license_status` is readable by anyone allowed in the
   channel and never shows the key.
3. **Environment** — `CHANNELGATE_LICENSE_KEY`, the bootstrap source for a container that has
   never had an admin session.

| Variable | Meaning |
| --- | --- |
| `CHANNELGATE_LICENSE_KEY` | the key, when it is not set in the admin UI |
| `CHANNELGATE_PLATFORM_URL` | the platform base URL (default `https://channelgate.dev`); also settable in the UI |
| `CHANNELGATE_LICENSE_PAYLOAD` | a signed offline license (see below) |
| `CHANNELGATE_LICENSE_PUBLIC_KEY` | overrides the compiled-in production verification key (staging or an explicitly coordinated key rotation only) |

## Offline (air-gapped) deployments

A deployment with no route to the platform can be issued the **signed payload** directly and set
it as `CHANNELGATE_LICENSE_PAYLOAD` (the JSON `{"license": …, "signature": …}` the verification
endpoint would have returned, raw or base64url). It is verified locally against the same public
key, so it can only ever say what the Licensor signed and it stops working at its own `expiresAt`.
An install running on one makes **no licensing request at all** — no verification and no usage
report.

## States

The gate is a small state machine. Every state is a *healthy* daemon state: no run is ever killed,
crashed, or silently dropped by the license check, and every state other than `no_key` and `valid`
raises a banner on the admin License card that says what happened and what to do about it.

| State | When | Limits in force |
| --- | --- | --- |
| `no_key` | no key configured | no-key tier |
| `valid` | the last check succeeded and the payload is in date | the payload's |
| `invalid` | the platform returned `401 invalid_key` | no-key tier, immediately |
| `revoked` | the platform returned `403 revoked` | no-key tier, immediately |
| `expired` | the licence passed its own `expiresAt` | no-key tier, immediately |
| `grace` | the platform is unreachable, within 14 days of the last success | the last verified tier (no-key tier if there has never been one) |
| `expired_grace` | unreachable for more than 14 days | the last verified tier **until the next UTC month boundary**, then the no-key tier |

`invalid` and `revoked` drop immediately because the platform has positively stated that the key
is not valid — that is a Section 3.2 statement, not a network problem. `expired` drops immediately
for the mirror-image reason: a licence that ran out on its own terms did not lose contact with
anything, and its end date was known in advance, so the offline courtesies do not apply to it. This
is checked *before* the unreachable lane and holds for an offline payload too — an air-gapped
deployment's payload stops granting its tier the moment it expires, exactly as this page has always
said it would. Only the *unreachable* path gets the month-boundary courtesy, because that failure
is usually the Licensor's, not yours. A response whose signature does not verify is treated as
unreachable in both directions: it can neither raise nor lower a tier.

## Counting, exactly

- The existing `(UTC month, channel id)` `license_usage` ledger counts AI runs and legacy
  active-channel admission. Its `conversations` signed limit retains this channel-ID meaning for
  compatibility; it is not the 100-thread product allowance. The Free default of 100 there is
  redundant with the 10-channel inventory cap; stricter signed active-channel limits still apply.
- `conversationsPerChannelPerMonth` is the signed thread allowance: 100 for Free and no-key,
  unlimited (`null`) by default for Enterprise. The separate monthly thread ledger is keyed by
  channel and the gateway's resolved thread identity. Platform-qualified channel IDs prevent
  collisions between identically named channels on different platforms.
- Admission and counting happen before engine spawn, atomically, so a refused turn does not
  count and concurrent first messages cannot exceed a cap. A run without a thread identity uses
  the gateway's stable unthreaded identity in that channel; it cannot create unlimited slots.
- Memory-review runs are excluded, by origin (`memory_review`) and by toolset
  (`CG_TOOLSET=memory-review`).
- The 80% AI-run warning is posted once per channel per month, prefixed to the answer the user is
  already receiving — it costs no extra message and cannot be missed.

## Seeing the state

- Admin UI: **Settings → License** — tier, key last four, when it was last verified, when the next
  check is due, the state banner, and this month's per-channel AI-run and active-thread usage with their limit lines.
- Chat: the `get_license_status` gateway tool.
- API: `GET /api/license` (admin session), and `POST /api/license/verify` to check now.

## Enterprise integrations and support status

Composio SDK mode is **Enterprise-only and Beta**, enforced when settings, sessions and bridge
requests are processed. The standard Composio MCP integration remains available in every tier.
Microsoft Teams and Google Chat connectors are **Beta**, with platform-specific live acceptance
required before relying on them for unattended work. Tier changes never weaken core security.

## Enterprise channel harness approvals

Organization admins can configure **Approved harnesses** in the admin channel editor or Slack
Settings → Agent. Leave the policy unrestricted, or approve one or more known harnesses. The
channel default must be approved. Channel selection, explicit thread pins, saved sessions,
per-run overrides, queued work and automatic failover are checked against the saved policy.
A disallowed selected harness produces a notice; it is never silently substituted to bypass a pin.
Background/scheduled/API turns use the same launch boundary. The Claude memory reviewer is
skipped when Claude is not approved.

Only an effective Enterprise license permits changing the policy. A saved restriction remains
enforced after downgrade or expiry; restoring Enterprise is required to change or clear it.
The default on existing channels is unrestricted. This governs gateway-managed harness launches,
not arbitrary commands a Worker/Admin author is otherwise allowed to execute inside a container.

## Cost-tracking history

Non-Enterprise installations expose one month (30 days) of cost history in audit and dashboard reports. Enterprise history is unlimited. Older accounting remains stored for upgrades; license usage counters and conversation history are independent. Structured costs older than the reporting window are also hidden in audit-event, API-job and schedule-telemetry responses, while their operational records and result text remain available.

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
See the regression checks under **Enterprise organization controls** in `TEST-PLAN.md`.
