// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROPRIETARY — MAKEITFUTURE S.R.L. All rights reserved.
// This file is part of src/ee/ and is NOT covered by the Sustainable Use License in LICENSE.md.
// It is source-visible so operators can audit the license check; use requires a valid license
// key issued by the Licensor. See src/ee/LICENSE-EE.md and LICENSE.md §3.2 / §4.5.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// License key storage, verification, and the state machine the run gate reads.
//
// Three hard rules shape this file, all of them from AGENTS.md:
//
//  1. **The daemon comes up even if the platform does not.** verifyLicense() is never awaited on
//     the boot path — `startLicenseVerification()` kicks it off and returns immediately, so Slack
//     connects while the request is still in flight. Until it lands, the gate reads the CACHED
//     state from `_meta`; a brand-new install with a key it has never verified is in `grace`, not
//     locked out.
//  2. **Unlicensed and unreachable are healthy states.** Nothing here throws into a run. Every
//     failure mode resolves to a state with limits attached.
//  3. **Every waiting state announces itself.** State changes emit on `licenseEvents` and are
//     rendered as a banner on the admin License card; the admin API exposes `nextCheckAt` so a
//     "we are between checks" state is visible rather than inferred.
//
// The state machine (see docs/LICENSE-KEYS.md, "Offline behaviour"):
//
//   state          | when                                                   | limits used
//   ---------------|--------------------------------------------------------|---------------------
//   no_key         | no key in Settings or CHANNELGATE_LICENSE_KEY          | NO_KEY_LIMITS
//   valid          | last verify returned 200 + a good signature            | the signed payload's
//   invalid        | last verify returned 401 invalid_key                   | NO_KEY_LIMITS
//   revoked        | last verify returned 403 revoked                       | NO_KEY_LIMITS
//   grace          | unreachable, verifiedAt within 14 days (or never yet)  | last verified tier
//   expired_grace  | unreachable, verifiedAt older than 14 days             | last verified tier
//                  |   …until the next UTC month boundary, then             | NO_KEY_LIMITS
//
// `invalid`/`revoked` drop to the no-key limits immediately: the platform has positively said the
// key is not valid, which is a §3.2 statement, not a network hiccup. Only the UNREACHABLE path
// gets the month-boundary courtesy, because that failure is usually ours, not the operator's.
import { createHash, createPublicKey, randomUUID, verify as edVerify } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { metaGet, metaSet } from "../db/index.js";
import { getLicenseKey, getSettings, saveSettings } from "../config/settings.js";
import { licensePublicKeyPem, isPlaceholderKey } from "./license-public-key.js";
import {
  GRACE_MS,
  NO_KEY_LIMITS,
  PLATFORM_TIMEOUT_MS,
  TIERS,
  VERIFY_INTERVAL_MS,
  canonicalJson,
  normalizeLimits,
  platformBaseUrl,
  signupUrl,
} from "./tiers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── _meta keys ────────────────────────────────────────────────────────────────────────────────
const META_INSTALLATION_ID = "license_installation_id";
const META_CACHE = "license_cache"; // { license, signature, verifiedAt, keyHash }
const META_LAST_CHECK = "license_last_check"; // { outcome, at, detail, keyHash }

export const LICENSE_STATES = Object.freeze(["no_key", "valid", "invalid", "revoked", "grace", "expired_grace"]);

// In-process state-change notifications for the UI/tools ("license" event with { from, to,
// status }). An EventEmitter, not a callback list, so more than one consumer can listen without
// them having to know about each other.
export const licenseEvents = new EventEmitter();
licenseEvents.setMaxListeners(20);

let lastAnnouncedState = "";

export function gatewayVersion() {
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const sha256Hex = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");

// ── Key storage ───────────────────────────────────────────────────────────────────────────────
// The resolution rule (UI-managed settings.json wins; CHANNELGATE_LICENSE_KEY is the bootstrap
// source, exactly like ADMIN_PASSWORD and CG_API_KEY) lives in config/settings.js, so the settings
// listing and the secrets allowlist can apply it without importing this proprietary directory.
// Re-exported here because this module is where the key is USED.
export { getLicenseKey };

export function hasLicenseKey() {
  return Boolean(getLicenseKey());
}

export function licenseKeyLast4() {
  const key = getLicenseKey();
  return key ? key.slice(-4) : "";
}

// Called after the stored key changes (admin PUT /api/settings, or the MCP tools below). Saving a
// DIFFERENT key invalidates the cached verification immediately: the cached payload is bound to a
// key hash, and serving the old tier under the new key would be exactly the key pooling §3.2
// forbids. A fresh verification is kicked off but NOT awaited — the admin save must not block on
// the platform, and the state machine already has an answer for "not verified yet" (grace).
export function onLicenseKeyChanged({ fetchImpl = globalThis.fetch, verify = true } = {}) {
  clearCacheIfKeyChanged();
  if (!hasLicenseKey()) {
    metaSet(META_CACHE, "");
    metaSet(META_LAST_CHECK, "");
  }
  const status = announceState();
  if (verify && hasLicenseKey()) {
    verifyLicense({ fetchImpl }).catch((e) => console.warn(`[license] verification after key change failed: ${e?.message || e}`));
  }
  return status;
}

export function setLicenseKey(key, options = {}) {
  const next = String(key ?? "").trim();
  saveSettings({ licenseKey: next });
  onLicenseKeyChanged(options);
  return next;
}

export function clearLicenseKey(options = {}) {
  saveSettings({ licenseKey: "" });
  onLicenseKeyChanged({ ...options, verify: false });
}

// ── Installation id ───────────────────────────────────────────────────────────────────────────
// A random uuid v4, minted once and kept in `_meta`. It identifies the INSTALL, not the operator:
// it is not derived from the hostname, the MAC address, the workspace, or anything else that
// would let the platform infer who is running it (docs/PRIVACY-AND-DATA-FLOW.md).
export function installationId() {
  const existing = metaGet(META_INSTALLATION_ID);
  if (existing) return existing;
  const id = randomUUID();
  metaSet(META_INSTALLATION_ID, id);
  return id;
}

// ── Cache ─────────────────────────────────────────────────────────────────────────────────────
function readJsonMeta(key) {
  try {
    const raw = metaGet(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ── Offline (air-gapped) license ──────────────────────────────────────────────────────────────
// A deployment with no route to the platform at all — an air-gapped network, a locked-down
// enterprise egress policy — can be handed the SIGNED payload directly in
// CHANNELGATE_LICENSE_PAYLOAD (the JSON `{ "license": …, "signature": … }` the verify endpoint
// would have returned, raw or base64url).
//
// This is not a bypass: the payload is checked against the SAME Ed25519 public key as a live
// response, so it can only ever say what the Licensor signed, and an expired one stops working on
// its own. It removes the network, never the license. An install running on one makes no outbound
// request at all — which is also why the test suite uses it (test/helpers.js).
function decodePayload(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    /* not raw JSON — try base64url */
  }
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

let offlineWarned = false;

export function offlineLicense(now = Date.now()) {
  const parsed = decodePayload(process.env.CHANNELGATE_LICENSE_PAYLOAD);
  if (!parsed) return null;
  if (!isWellFormedLicense(parsed.license) || !verifySignature(parsed.license, parsed.signature)) {
    if (!offlineWarned) {
      offlineWarned = true;
      console.warn("[license] CHANNELGATE_LICENSE_PAYLOAD is present but does not verify against the license public key — ignoring it");
    }
    return null;
  }
  const key = getLicenseKey();
  return {
    license: parsed.license,
    signature: parsed.signature,
    // Stamped at READ time on purpose: an offline license never ages into the grace window,
    // because there is nothing for it to be out of contact with. Its own `expiresAt` is the clock
    // that matters, and resolveLicenseState() already honours that.
    verifiedAt: new Date(now).toISOString(),
    keyHash: key ? sha256Hex(key) : "",
    offline: true,
  };
}

export function readCache(now = Date.now()) {
  const offline = offlineLicense(now);
  if (offline) return offline;
  const cache = readJsonMeta(META_CACHE);
  if (!cache || !cache.license || !cache.verifiedAt) return null;
  return cache;
}

export function readLastCheck(now = Date.now()) {
  if (offlineLicense(now)) return { outcome: "verified", at: new Date(now).toISOString(), detail: "offline payload", keyHash: "" };
  return readJsonMeta(META_LAST_CHECK);
}

function clearCacheIfKeyChanged() {
  if (offlineLicense()) return; // the offline payload lives in the environment, not in _meta
  const key = getLicenseKey();
  const hash = key ? sha256Hex(key) : "";
  const cache = readCache();
  if (cache && cache.keyHash !== hash) metaSet(META_CACHE, "");
  const last = readLastCheck();
  if (last && last.keyHash !== hash) metaSet(META_LAST_CHECK, "");
}

// ── Signature verification ────────────────────────────────────────────────────────────────────
// Ed25519 over the canonical JSON of the `license` object, base64url. Anything that is not a
// clean verification — a malformed key, a malformed signature, a tampered payload — returns
// false; it never throws, because a thrown error here would land in the middle of a boot.
export function verifySignature(license, signature, pem = licensePublicKeyPem()) {
  try {
    if (!license || typeof license !== "object" || !signature) return false;
    const key = createPublicKey(pem);
    const sig = Buffer.from(String(signature), "base64url");
    if (sig.length !== 64) return false; // Ed25519 signatures are exactly 64 bytes
    return edVerify(null, Buffer.from(canonicalJson(license), "utf8"), key, sig);
  } catch {
    return false;
  }
}

// A payload the daemon is willing to cache. A tier it has never heard of is refused rather than
// defaulted: an unknown tier with an unlimited `limits` blob would otherwise be a free upgrade
// for anyone who can forge a response (they cannot — see verifySignature — but the two checks are
// independent on purpose).
export function isWellFormedLicense(license) {
  if (!license || typeof license !== "object") return false;
  if (!TIERS.includes(license.tier)) return false;
  if (typeof license.keyId !== "string" || !license.keyId) return false;
  if (license.expiresAt != null && typeof license.expiresAt !== "string") return false;
  return true;
}

// ── The state machine ─────────────────────────────────────────────────────────────────────────
export function utcMonth(at = Date.now()) {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// The first instant of the UTC month AFTER the one `at` falls in. The grace fallback waits for
// this: docs/LICENSE-KEYS.md promises the drop happens at the start of the next calendar month,
// "never mid-month, never silently".
export function nextUtcMonthStart(at) {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

function cachedLicenseExpired(cache, now) {
  const expiresAt = cache?.license?.expiresAt;
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  return Number.isFinite(ts) && ts <= now;
}

// The whole gate, as a pure function of (key present?, cache, last check, clock). Exported so the
// tests can drive it with a fake clock instead of waiting fourteen days.
export function resolveLicenseState({ keyPresent, cache, lastCheck, now = Date.now() } = {}) {
  if (!keyPresent) {
    return { state: "no_key", limits: NO_KEY_LIMITS, license: null, verifiedAt: "", reason: "" };
  }

  const outcome = lastCheck?.outcome || "";
  if (outcome === "invalid") {
    return { state: "invalid", limits: NO_KEY_LIMITS, license: null, verifiedAt: cache?.verifiedAt || "", reason: lastCheck?.detail || "invalid_key" };
  }
  if (outcome === "revoked") {
    return { state: "revoked", limits: NO_KEY_LIMITS, license: null, verifiedAt: cache?.verifiedAt || "", reason: lastCheck?.detail || "revoked" };
  }

  const verifiedAtMs = cache?.verifiedAt ? Date.parse(cache.verifiedAt) : NaN;
  const haveCache = Boolean(cache?.license) && Number.isFinite(verifiedAtMs);

  // The happy path: the most recent check succeeded and the cached payload is still in date.
  if (outcome === "verified" && haveCache && !cachedLicenseExpired(cache, now)) {
    return {
      state: "valid",
      limits: normalizeLimits(cache.license.limits, cache.license.tier),
      license: cache.license,
      verifiedAt: cache.verifiedAt,
      reason: "",
    };
  }

  // Everything below is the UNREACHABLE lane (including "reachable but the response did not
  // verify" and "the cached payload passed its expiresAt while we could not re-check").
  // No cache at all — a key we have never managed to verify. Grace, so a first boot behind a
  // proxy outage is not a lockout; the banner says the check has not landed yet.
  if (!haveCache) {
    return { state: "grace", limits: NO_KEY_LIMITS, license: null, verifiedAt: "", reason: lastCheck?.detail || "never verified" };
  }

  const lastTier = normalizeLimits(cache.license.limits, cache.license.tier);
  const graceEndsAt = verifiedAtMs + GRACE_MS;
  if (now < graceEndsAt) {
    return { state: "grace", limits: lastTier, license: cache.license, verifiedAt: cache.verifiedAt, reason: lastCheck?.detail || "platform unreachable" };
  }

  // Beyond 14 days. Keep the last tier until the month in which grace ran out is over — the
  // fallback lands on a UTC month boundary, never mid-month.
  const fallbackAt = nextUtcMonthStart(graceEndsAt);
  const fellBack = now >= fallbackAt;
  return {
    state: "expired_grace",
    limits: fellBack ? NO_KEY_LIMITS : lastTier,
    license: cache.license,
    verifiedAt: cache.verifiedAt,
    reason: lastCheck?.detail || "platform unreachable",
    graceEndedAt: new Date(graceEndsAt).toISOString(),
    fallbackAt: new Date(fallbackAt).toISOString(),
    fellBack,
  };
}

// "Is this deployment licensed at all?" — a key in Settings/env, or a signed offline payload.
// Only used to word the refusal notices ("get a free key" vs "raise the limit"); the LIMITS
// always come from the state machine.
export function isLicensed(now = Date.now()) {
  return hasLicenseKey() || Boolean(offlineLicense(now));
}

function currentResolution(now = Date.now()) {
  return resolveLicenseState({ keyPresent: isLicensed(now), cache: readCache(now), lastCheck: readLastCheck(now), now });
}

// The one function the run gate calls. Reads only cached state — no network, no await on a check.
export function getEffectiveLimits(now = Date.now()) {
  return currentResolution(now).limits;
}

// Everything the admin UI and the MCP tools render.
export function getLicenseStatus(now = Date.now()) {
  const r = currentResolution(now);
  const lastCheck = readLastCheck();
  const lastCheckAt = lastCheck?.at || "";
  const lastCheckMs = lastCheckAt ? Date.parse(lastCheckAt) : NaN;
  return {
    state: r.state,
    tier: r.license?.tier || (r.state === "no_key" ? "none" : "none"),
    organization: r.license?.organization || "",
    keyId: r.license?.keyId || "",
    issuedAt: r.license?.issuedAt || "",
    expiresAt: r.license?.expiresAt || null,
    limits: r.limits,
    hasLicenseKey: hasLicenseKey(),
    licenseKeyLast4: licenseKeyLast4(),
    licenseKeySource: getSettings().licenseKey ? "settings" : hasLicenseKey() ? "env" : "",
    offline: Boolean(offlineLicense(now)),
    verifiedAt: r.verifiedAt || "",
    lastCheckAt,
    lastCheckOutcome: lastCheck?.outcome || "",
    nextCheckAt: Number.isFinite(lastCheckMs) ? new Date(lastCheckMs + VERIFY_INTERVAL_MS).toISOString() : "",
    graceEndedAt: r.graceEndedAt || "",
    fallbackAt: r.fallbackAt || "",
    fellBack: Boolean(r.fellBack),
    reason: r.reason || "",
    installationId: installationId(),
    platformUrl: platformBaseUrl(),
    signupUrl: signupUrl(),
    placeholderPublicKey: isPlaceholderKey(),
    banner: bannerFor(r),
    version: gatewayVersion(),
  };
}

// The one-line banner the admin card shows. `valid` and `no_key` are quiet states — a green
// install should not carry a warning strip — but every other state says what happened and what
// the operator can do about it.
export function bannerFor(r) {
  switch (r.state) {
    case "invalid":
      return { level: "error", text: "This license key was rejected by the ChannelGate platform. The no-key limits apply until a valid key is saved." };
    case "revoked":
      return { level: "error", text: "This license key has been revoked. The no-key limits apply until a valid key is saved." };
    case "grace":
      return {
        level: "warn",
        text: r.license
          ? "The ChannelGate platform is unreachable — running on the last verified tier. This lasts 14 days from the last successful check."
          : "This key has not been verified yet — the ChannelGate platform is unreachable. The no-key limits apply until a check succeeds.",
      };
    case "expired_grace":
      return {
        level: "error",
        text: r.fellBack
          ? "The 14-day offline grace period ended and the no-key limits are now in force. Reconnect the deployment to the ChannelGate platform to restore your tier."
          : "The 14-day offline grace period has ended. Your tier is kept until the start of the next UTC month, then the no-key limits apply.",
      };
    default:
      return null;
  }
}

function announceState(now = Date.now()) {
  const status = getLicenseStatus(now);
  if (status.state === lastAnnouncedState) return status;
  const from = lastAnnouncedState;
  lastAnnouncedState = status.state;
  try {
    licenseEvents.emit("license", { from, to: status.state, status });
  } catch (e) {
    console.warn(`[license] state listener threw (ignored): ${e?.message || e}`);
  }
  return status;
}

// Test seam: the "did the state change?" memo is module state.
export function resetLicenseAnnouncements() {
  lastAnnouncedState = "";
}

// ── Verification ──────────────────────────────────────────────────────────────────────────────
// One round trip to POST {base}/v1/license/verify. NEVER throws: every outcome is recorded in
// `_meta` and reflected by the state machine above.
//
//   200 + good signature → cached, state `valid`
//   200 + bad signature  → NOT cached, treated as unreachable. A response we cannot authenticate
//                          is not evidence of anything, in either direction: caching it would let
//                          a hostile network mint a tier, and treating it as `invalid` would let
//                          the same network downgrade a paying deployment.
//   401 invalid_key      → state `invalid`
//   403 revoked          → state `revoked`
//   anything else / throw/ timeout → unreachable (grace)
export async function verifyLicense({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  // An offline payload is already a verified license. Never make the request — the whole point of
  // that mode is that this install has no route to the platform.
  if (offlineLicense(now())) return { ...announceState(now()), outcome: "verified", detail: "offline payload" };
  const key = getLicenseKey();
  if (!key) {
    metaSet(META_LAST_CHECK, JSON.stringify({ outcome: "no_key", at: new Date(now()).toISOString(), detail: "", keyHash: "" }));
    return { ...announceState(now()), outcome: "no_key" };
  }
  clearCacheIfKeyChanged();
  const keyHash = sha256Hex(key);
  const at = new Date(now()).toISOString();
  let outcome = "unreachable";
  let detail = "";

  try {
    const res = await fetchImpl(`${platformBaseUrl()}/v1/license/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ key, installationId: installationId(), version: gatewayVersion() }),
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
    });
    if (res.status === 401) {
      outcome = "invalid";
      detail = "invalid_key";
    } else if (res.status === 403) {
      outcome = "revoked";
      detail = "revoked";
    } else if (res.status === 200) {
      const body = await res.json().catch(() => null);
      if (!body?.ok || !isWellFormedLicense(body.license)) {
        detail = "malformed response";
      } else if (!verifySignature(body.license, body.signature)) {
        // Loud on purpose: on a correctly deployed install this is either a MITM or a key rollout
        // that has not reached this checkout (see license-public-key.js).
        console.warn("[license] platform response failed signature verification — ignoring it and staying on the cached state");
        detail = "signature verification failed";
      } else {
        outcome = "verified";
        metaSet(META_CACHE, JSON.stringify({ license: body.license, signature: body.signature, verifiedAt: at, keyHash }));
      }
    } else {
      detail = `HTTP ${res.status}`;
    }
  } catch (e) {
    detail = e?.name === "TimeoutError" ? "timeout" : String(e?.message || e);
  }

  metaSet(META_LAST_CHECK, JSON.stringify({ outcome, at, detail, keyHash }));
  const status = announceState(now());
  if (outcome !== "verified" && outcome !== "invalid" && outcome !== "revoked") {
    console.warn(`[license] platform check failed (${detail || "unreachable"}) — state: ${status.state}`);
  }
  return { ...status, outcome, detail };
}

// ── Boot wiring ───────────────────────────────────────────────────────────────────────────────
let verifyTimer = null;

// Fire-and-forget. Called from src/server.js BEFORE Slack connects and deliberately NOT awaited:
// a platform that is slow, unroutable, or black-holing packets must cost the boot nothing. The
// run gate uses the cached state until this lands.
export function startLicenseVerification({ fetchImpl = globalThis.fetch, intervalMs = VERIFY_INTERVAL_MS } = {}) {
  announceState();
  const tick = () => {
    verifyLicense({ fetchImpl }).catch((e) => console.warn(`[license] verification failed: ${e?.message || e}`));
  };
  tick();
  stopLicenseVerification();
  verifyTimer = setInterval(tick, intervalMs);
  verifyTimer.unref?.();
  return () => stopLicenseVerification();
}

export function stopLicenseVerification() {
  if (verifyTimer) clearInterval(verifyTimer);
  verifyTimer = null;
}
