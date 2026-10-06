---
title: Offline licensing
description: Use a signed license payload and understand unreachable-platform grace behavior.
---

An installation without a route to the licensing platform can use a **signed license payload**. This preserves license verification while removing the need for online verification requests.

## Configure a signed payload

The operator supplies `CHANNELGATE_LICENSE_PAYLOAD` to the daemon environment. It accepts the platform-issued JSON object containing `license` and `signature`, either as raw JSON or base64url. The daemon verifies the same Ed25519 signature used for online responses.

Obtain the signed payload through the licensor's supported process. Editing its tier or limits invalidates the signature. A payload with its own expiry stops granting the tier when that expiry passes; offline verification is not indefinite renewal.

No separate offline-payload editor exists in the admin web form. **Settings → License** shows license state and limits. Keep payload/key material out of public repositories and chat messages.

## Temporary online outages

An ordinary previously verified license keeps its last verified tier for **14 days** of unreachable-platform grace. After that, the tier is retained until the start of the next UTC month following the end of grace, then no-key limits apply.

A never-verified key does not grant a tier merely because the platform is unreachable. Positive invalid/revoked responses and the license's own expiry follow their explicit no-key fallback; they are not treated as network grace.

## Practical checks

Inspect license state, verification time, expiry, and applicable limits before attributing admission failures to engine authentication. The no-key fallback permits one conversation per UTC month and 500 AI messages in that conversation.

## Related guides

- [Licensing](/docs/features/licensing)
- [License controls](/docs/controls/licensing)
- [License keys reference](/docs/licensing)
