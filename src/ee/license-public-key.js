// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROPRIETARY — MAKEITFUTURE S.R.L. All rights reserved.
// This file is part of src/ee/ and is NOT covered by the Sustainable Use License in LICENSE.md.
// It is source-visible so operators can audit the license check; use requires a valid license
// key issued by the Licensor. See src/ee/LICENSE-EE.md and LICENSE.md §3.2 / §4.5.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The Ed25519 public key that every license payload is verified against.
//
// A license response is only as trustworthy as this key: the platform signs the canonical JSON of
// the `license` object and the daemon verifies that signature locally, so a hostile network (or a
// DNS answer pointed at somebody else's server) can withhold a verification — which lands in the
// grace state — but can never mint a tier.
//
// The production key published by https://channelgate.vercel.app/v1/license/public-key. Its
// private half exists only in the Licensor's key store and the platform's server-side secrets.
// Staging and tests override this through CHANNELGATE_LICENSE_PUBLIC_KEY instead of editing the
// shipped trust root — the tests generate their own pair per run.

const PRODUCTION_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbXN9l8r94LbSp1ybwWGXmXSDzIwWS5P5yM846TIZlXY=
-----END PUBLIC KEY-----
`;

// Retained only so old development builds can still identify and report the unusable placeholder.
const PLACEHOLDER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGifTHprvQdMSnHH/n3kxprEs4oAR1LX+q8I/wBY1wQA=
-----END PUBLIC KEY-----
`;

// True while this checkout still carries the placeholder — the admin UI says so, because a
// deployment built against it can never reach the `valid` state.
export function isPlaceholderKey(pem = licensePublicKeyPem()) {
  return String(pem).replace(/\s+/g, "") === PLACEHOLDER_PUBLIC_KEY_PEM.replace(/\s+/g, "");
}

// Env override wins, so staging/tests never rewrite the shipped constant. Newline escapes are
// accepted because a PEM in an environment variable usually arrives as one line.
export function licensePublicKeyPem() {
  const override = String(process.env.CHANNELGATE_LICENSE_PUBLIC_KEY || "").trim();
  if (override) return override.includes("\\n") ? override.replace(/\\n/g, "\n") : override;
  return PRODUCTION_PUBLIC_KEY_PEM;
}

export { PLACEHOLDER_PUBLIC_KEY_PEM, PRODUCTION_PUBLIC_KEY_PEM };
