// One master secret, one derived key per purpose.
//
// The daemon's per-process secret (`CG_APPROVAL_SECRET`, random per boot unless an operator pins it
// in .env) used to be the raw HMAC key of two unrelated token kinds — the run capability a turn's
// control-plane connection carries (src/gateway/mcp-capability.js) and the signed browser approval
// links (src/web/approval-links.js) — as well as the loopback IPC credential. The two formats differ
// enough that neither parses as the other today, but that is an accident of today's formats, not a
// property anyone checks. Each signing purpose now gets its own key, derived with HKDF-SHA256 under
// a fixed purpose label, so a tag minted for one kind is meaningless for every other kind by
// construction, and a signed token never carries a MAC under the raw IPC credential. The master
// itself remains the loopback IPC credential (compared, never used to sign).
//
// Leaf module (node:crypto only): the stdio MCP child and the daemon both derive the same key from
// the same master, so nothing new has to cross a process boundary.
import { hkdfSync } from "node:crypto";

export const KEY_PURPOSES = Object.freeze({
  RUN_CAPABILITY: "run-capability",
  APPROVAL_LINK: "approval-link",
});
const LABELS = new Map(Object.values(KEY_PURPOSES).map((purpose) => [purpose, `channelgate/${purpose}/v1`]));
const SALT = Buffer.from("channelgate purpose keys", "utf8");

// The master rarely changes (once per boot), so a tiny cache keeps the per-tool-call verifier from
// re-running HKDF. Keyed by purpose; a different master replaces the entry.
const cache = new Map(); // purpose → { master, key }

/** The 32-byte key for `purpose`, derived from `master`. Throws on an empty master or unknown purpose. */
export function purposeKey(master, purpose) {
  const label = LABELS.get(purpose);
  if (!label) throw new Error(`unknown key purpose: ${purpose}`);
  const secret = String(master || "");
  if (!secret) throw new Error("no master secret to derive a key from");
  const hit = cache.get(purpose);
  if (hit && hit.master === secret) return hit.key;
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), SALT, Buffer.from(label, "utf8"), 32));
  cache.set(purpose, { master: secret, key });
  return key;
}
