# License keys, tiers, and usage limits

Referenced by Section 3.2 of [`LICENSE.md`](../LICENSE.md). This page describes the tiers and
limits that apply to the current version; the Licensor may set different limits for future
versions and for the keys it issues. Limits are delivered to a deployment by the ChannelGate
platform, so they can change without a new release; the limits that apply to an enterprise key
are fixed for its agreed term.

## Tiers

| Tier | How you get it | Conversations | AI messages per conversation per month |
| --- | --- | --- | --- |
| **No key** | install and run | 1 | 500 |
| **Free key** | create an account with your email on the ChannelGate platform | unlimited | 500 |
| **Enterprise key** | Enterprise License with Makeitfuture | unlimited | unlimited |

## Definitions

- A **conversation** is a distinct channel, group, or direct-message thread on a supported chat
  platform, as identified by the Software. Without a key, the first conversation that receives an
  AI message in a calendar month is the one the deployment serves for that month.
- An **AI message** is one engine run started for a conversation. Every origin counts — user
  turns, follow-ups, scheduled runs, and background jobs — except the deployment's own
  memory-review runs. Months are calendar months in UTC.
- At the monthly limit the assistant answers with a short notice instead of starting a run; it
  warns once at 80 %.

## Whose key

A key belongs to the **organization that operates the deployment** — an end-user key. An agency or
service provider that installs or operates ChannelGate for a customer under Section 3.1 uses the
customer's key: the customer creates the account with its own email and may add the provider as a
manager. Keys are never shared, pooled, or transferred across organizations.

## What the deployment sends to the platform

Key verification runs at start-up and about once a day; usage is reported as counts. The payload
contains the key (hashed), an installation id, the software version, and per-conversation
**hashed** ids with message counts. It never contains message content, user identities, channel
names, credentials, or files. The full data-flow description is in
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

Enforcement happens in one place: `licenseAdmission()` is called by the run orchestrator
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
An install running on one makes **no outbound request at all** — no verification and no usage
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

- The counters are keyed on `(UTC month, conversation id)` in the local `license_usage` table
  (schema migration 12). Nothing else reads or writes them.
- A run is counted **at spawn**, so a refused turn never counts and a burst of concurrent turns
  cannot slip past a cap that is already reached.
- The conversation id is the qualified id from `src/platforms/ids.js`, so the same channel name on
  two different chat platforms is two different conversations.
- Memory-review runs are excluded, by origin (`memory_review`) and by toolset
  (`CG_TOOLSET=memory-review`).
- The 80% warning is posted once per conversation per month, prefixed to the answer the user is
  already receiving — it costs no extra message and cannot be missed.

## Seeing the state

- Admin UI: **Settings → License** — tier, key last four, when it was last verified, when the next
  check is due, the state banner, and this month's per-conversation usage with the limit line.
- Chat: the `get_license_status` gateway tool.
- API: `GET /api/license` (admin session), and `POST /api/license/verify` to check now.
