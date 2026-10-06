---
title: License controls
description: Read deployment admission limits and manage the license key with administrator authorization.
---

License controls act on the entire gateway deployment. The license key affects conversation and monthly AI-message admission; it does not provide model-provider usage, hosting, or connector credentials.

## get_license_status

**Arguments:** none. **Authority:** any authorized conversation participant. **Extra control approval:** none.

Returns tier, state, conversation/message limits, verification/expiry information, and current-month usage. The full key is never returned; status can show its last four characters and source. Busiest-conversation counts are bounded to a short summary. Use this when explaining admission refusal or approaching limits.

Example arguments:

```json
{}
```

## set_license_key

**Required:** `key` (string). **Optional:** none. **Authority:** gateway admin, with explicit control approval.

Trims and validates the supplied key shape, stores it, and immediately requests verification. Returns the verification outcome and updated status. The new entitlement applies to later runs; saved does not imply successfully verified.

Prefer **Settings → License** for entry rather than posting key material into chat. If a key is sent by chat, use a DM and delete the containing message afterward; key redaction in a response does not remove it from history. The tool reports a masked suffix, not the full value. This tool does not issue a key or construct a signed offline payload.

Example arguments:

```json
{"key":"<issued-license-key>"}
```

## clear_license_key

**Arguments:** none. **Authority:** gateway admin, with explicit control approval.

Removes the configured online key. Ordinary no-key admission is **one conversation per UTC month and 500 AI messages in it**. A separately configured valid signed offline payload is an independent license source, so clearing the online key should not be described as removing that environment payload. Read status after the change.

This operation does not delete work folders, memory, historical usage, or model authentication. It changes admission for subsequent runs.

Example arguments:

```json
{}
```

## Related guides

- [Licensing](/docs/features/licensing)
- [Offline licensing](/docs/features/offline-licensing)
- [License keys reference](/docs/licensing)
