// Placeholder credentials: what a container holds INSTEAD of a real secret.
//
// Why: a channel container is a shared trust domain (every admitted member runs as the same uid and
// can read every process's environment), so the container must never hold a real credential. It
// holds a placeholder the daemon-side egress proxy swaps for the real value only on requests to the
// hosts and headers that secret is declared for. A placeholder taken out of the container is
// worthless on its own.
//
// Format: `cgph_<scope letter><32 lowercase base32 chars>` (160 random bits). The fixed prefix makes
// detection in headers, logs, replies and memory trivial. Scope letters: `o` organization,
// `c` channel, `p` personal, `r` relay (an engine token such as the Claude access-token relay).
// Engines that validate a token's SHAPE get a shape-preserving wrapper that keeps the `cgph_`
// marker inside (`sk-ant-oat01-cgph_r…`), and the detector matches the wrapped form as one token.
// The CORE placeholder (`cgph_…`) is the identity a grant is keyed by; the wrapped token is only
// how it travels.
//
// A JWT-shaped placeholder (the Codex login, whose CLI parses its access token as a JWT and
// rejects anything else) is `<header>.<payload>.cgph_r…`: the REAL token's header and payload —
// the operator's own identity claims and expiry, which the CLI reads locally — with the placeholder
// as the SIGNATURE segment. The signature is the only part the provider verifies, so the token is
// worthless outside, and the `.` before the core is a boundary the detector already accepts.
// `JWT_PLACEHOLDER_RE` recognizes the whole three-segment token; the swap rules replace it WHOLE
// (format `jwt`, rules.js).
import crypto from "node:crypto";

export const PLACEHOLDER_PREFIX = "cgph_";

const SCOPE_LETTERS = { org: "o", channel: "c", personal: "p", relay: "r" };
const LETTER_SCOPES = Object.fromEntries(Object.entries(SCOPE_LETTERS).map(([scope, letter]) => [letter, scope]));
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

// Engine token shapes we preserve. The wrapper is a literal prefix in front of the core placeholder.
export const PLACEHOLDER_SHAPES = Object.freeze({ "anthropic-oauth": "sk-ant-oat01-" });

// One token: an optional shape prefix, then the core (captured as group 1). The boundaries keep a
// placeholder embedded in a longer alphanumeric run from matching. Global: use with matchAll/replace.
export const PLACEHOLDER_RE = /(?<![A-Za-z0-9])(?:sk-ant-oat01-)?(cgph_[ocpr][a-z2-7]{32})(?![A-Za-z0-9])/g;

// Exactly one JWT-shaped placeholder: two base64url segments, then the core as the signature.
// Anchored (no global flag), so it is linear on any input.
export const JWT_PLACEHOLDER_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.(cgph_[ocpr][a-z2-7]{32})$/;
const JWT_RE = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/;

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function scopeLetter(scope) {
  const letter = SCOPE_LETTERS[scope] || (LETTER_SCOPES[scope] ? scope : null);
  if (!letter) throw new Error(`unknown placeholder scope: ${scope}`);
  return letter;
}

// `scope` is "org" | "channel" | "personal" | "relay" (or the letter itself).
export function mintPlaceholder({ scope }) {
  return `${PLACEHOLDER_PREFIX}${scopeLetter(scope)}${base32(crypto.randomBytes(20))}`;
}

// The header and payload segments of a JWT, or null when `jwt` is not one (three base64url
// segments, the first two decoding to JSON objects). Never verifies anything: it only has to keep
// the real token's CLAIMS readable for the CLI that parses them.
export function jwtClaimSegments(jwt) {
  const m = JWT_RE.exec(String(jwt ?? "").trim());
  if (!m) return null;
  try {
    for (const segment of [m[1], m[2]]) {
      const decoded = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    }
  } catch {
    return null;
  }
  return { header: m[1], payload: m[2] };
}

// Wrap an EXISTING core placeholder in a token shape. `jwt` shape: `claimsFrom` is the real JWT
// whose header and payload the placeholder carries (throws when it is not a JWT).
export function wrapPlaceholder(core, { shape, claimsFrom = "" } = {}) {
  const text = String(core ?? "");
  if (!/^cgph_[ocpr][a-z2-7]{32}$/.test(text)) throw new Error("wrapPlaceholder needs a core placeholder");
  if (shape === "jwt") {
    const segments = jwtClaimSegments(claimsFrom);
    if (!segments) throw new Error("a jwt-shaped placeholder needs the real token's claims (a JWT)");
    return `${segments.header}.${segments.payload}.${text}`;
  }
  const prefix = PLACEHOLDER_SHAPES[shape];
  if (prefix === undefined) throw new Error(`unknown placeholder shape: ${shape}`);
  return `${prefix}${text}`;
}

// A placeholder wearing an engine's token shape. Register the CORE (`corePlaceholder(token)`) as
// the grant's placeholder; hand the shaped token to the engine. `claims` is the real JWT for the
// `jwt` shape.
export function shapePlaceholder({ scope, shape, claims = "" }) {
  if (shape !== "jwt" && PLACEHOLDER_SHAPES[shape] === undefined) throw new Error(`unknown placeholder shape: ${shape}`);
  return wrapPlaceholder(mintPlaceholder({ scope }), { shape, claimsFrom: claims });
}

// The unique CORE placeholders in `text`, in first-seen order.
export function findPlaceholders(text) {
  if (typeof text !== "string" || !text.includes(PLACEHOLDER_PREFIX)) return [];
  return [...new Set(Array.from(text.matchAll(PLACEHOLDER_RE), (m) => m[1]))];
}

// The core of a (possibly shaped) placeholder token, or null when `token` is not exactly one.
export function corePlaceholder(token) {
  const text = String(token ?? "");
  const jwt = JWT_PLACEHOLDER_RE.exec(text);
  if (jwt) return jwt[1];
  const match = [...text.matchAll(PLACEHOLDER_RE)];
  return match.length === 1 && match[0].index === 0 && match[0][0].length === text.length ? match[0][1] : null;
}

// "org" | "channel" | "personal" | "relay" for a core placeholder, else null.
export function placeholderScope(placeholder) {
  const core = corePlaceholder(placeholder);
  return core ? LETTER_SCOPES[core[PLACEHOLDER_PREFIX.length]] : null;
}
