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

// A placeholder wearing an engine's token shape. Register the CORE (`corePlaceholder(token)`) as
// the grant's placeholder; hand the shaped token to the engine.
export function shapePlaceholder({ scope, shape }) {
  const prefix = PLACEHOLDER_SHAPES[shape];
  if (prefix === undefined) throw new Error(`unknown placeholder shape: ${shape}`);
  return `${prefix}${mintPlaceholder({ scope })}`;
}

// The unique CORE placeholders in `text`, in first-seen order.
export function findPlaceholders(text) {
  if (typeof text !== "string" || !text.includes(PLACEHOLDER_PREFIX)) return [];
  return [...new Set(Array.from(text.matchAll(PLACEHOLDER_RE), (m) => m[1]))];
}

// The core of a (possibly shaped) placeholder token, or null when `token` is not exactly one.
export function corePlaceholder(token) {
  const text = String(token ?? "");
  const match = [...text.matchAll(PLACEHOLDER_RE)];
  return match.length === 1 && match[0].index === 0 && match[0][0].length === text.length ? match[0][1] : null;
}

// "org" | "channel" | "personal" | "relay" for a core placeholder, else null.
export function placeholderScope(placeholder) {
  const core = corePlaceholder(placeholder);
  return core ? LETTER_SCOPES[core[PLACEHOLDER_PREFIX.length]] : null;
}
