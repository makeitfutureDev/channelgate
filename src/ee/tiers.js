// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROPRIETARY — MAKEITFUTURE S.R.L. All rights reserved.
// This file is part of src/ee/ and is NOT covered by the Sustainable Use License in LICENSE.md.
// It is source-visible so operators can audit the license check; use requires a valid license
// key issued by the Licensor. See src/ee/LICENSE-EE.md and LICENSE.md §3.2 / §4.5.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The compiled-in facts of the licensing model: the platform URL, the tier defaults, and the
// canonical JSON encoding the signature is computed over. Everything else about a tier is
// SERVER-defined — `limits` rides on the signed payload precisely so the Licensor can change what
// a key is worth without shipping a release (docs/LICENSE-KEYS.md, "Changing the limits").
//
// `null` means UNLIMITED. It is not "unset": a free key that omits `conversations` gets `null`
// (unlimited conversations, the published free tier), while a deployment with NO key at all gets
// the hard-coded 1. Reading "missing" as "unlimited" everywhere would make a truncated payload an
// upgrade, so the fill-in is explicit per tier below.

// One home for the base URL. Env wins over the compiled default; Settings (`platformUrl`) is
// copied into the env at boot and on save, exactly like the other UI-managed settings.
export const DEFAULT_PLATFORM_URL = "https://makeitfuture.com/channelgate/api";

export function platformBaseUrl() {
  const raw = String(process.env.CHANNELGATE_PLATFORM_URL || "").trim() || DEFAULT_PLATFORM_URL;
  return raw.replace(/\/+$/, "");
}

// Where an operator without a key goes to get one — shown in every refusal notice and on the
// admin card. Derived from the API base so a staging deployment points at its own site.
export function signupUrl() {
  const base = platformBaseUrl();
  return base.replace(/\/api$/, "") || DEFAULT_PLATFORM_URL.replace(/\/api$/, "");
}

export const TIERS = Object.freeze(["free", "enterprise"]);

// No key at all. Compiled in — there is nobody to ask for these.
export const NO_KEY_LIMITS = Object.freeze({ conversations: 1, messagesPerConversationPerMonth: 500 });

// Per-tier fill-ins for fields a signed payload omits.
const TIER_DEFAULTS = Object.freeze({
  free: Object.freeze({ conversations: null, messagesPerConversationPerMonth: 500 }),
  enterprise: Object.freeze({ conversations: null, messagesPerConversationPerMonth: null }),
});

export function tierDefaults(tier) {
  return TIER_DEFAULTS[String(tier)] || TIER_DEFAULTS.free;
}

// A limit is a non-negative integer or null (unlimited). Anything else — a string, NaN, a
// negative — is a malformed payload field and falls back to the tier default rather than being
// coerced into 0, which would lock the deployment out of its own conversations.
function normalizeLimit(value, fallback) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

export function normalizeLimits(limits, tier) {
  const d = tierDefaults(tier);
  const l = limits && typeof limits === "object" ? limits : {};
  return Object.freeze({
    conversations: Object.hasOwn(l, "conversations") ? normalizeLimit(l.conversations, d.conversations) : d.conversations,
    messagesPerConversationPerMonth: Object.hasOwn(l, "messagesPerConversationPerMonth")
      ? normalizeLimit(l.messagesPerConversationPerMonth, d.messagesPerConversationPerMonth)
      : d.messagesPerConversationPerMonth,
  });
}

// Canonical JSON: JSON.stringify with object keys sorted recursively and no whitespace. This is
// the exact byte string the platform signs and the daemon verifies — the two sides agree on it or
// nothing verifies, so it lives here rather than being re-derived at each call site. Arrays keep
// their order (order is data); `undefined` members are dropped by JSON.stringify on both sides.
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

// Grace: how long a deployment keeps its last verified tier while the platform is unreachable.
export const GRACE_DAYS = 14;
export const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

// How often a running daemon re-verifies, and how often it reports usage.
export const VERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const USAGE_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Network calls to the platform are strictly bounded: the license check must never be able to
// hold up a boot, a turn, or a shutdown.
export const PLATFORM_TIMEOUT_MS = 10_000;
