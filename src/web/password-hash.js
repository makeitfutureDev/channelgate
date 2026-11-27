// Admin password hashing and the constant-time string compare, as a dependency-free leaf: only
// node:crypto, no settings and no database. security.js re-exports everything here for the web
// layer; `scripts/hash-password.mjs` and the boot posture check import this file directly so
// neither drags the daemon's configuration graph along.
import crypto from "node:crypto";

// ── Constant-time compare ───────────────────────────────────────────────────────
// Compare via fixed-size SHA-256 digests: timingSafeEqual needs equal-length inputs, and a raw
// length pre-check would leak when a guess matches the secret's length. Digests never do.
export function timingSafeEqualStr(a, b) {
  const da = crypto.createHash("sha256").update(String(a)).digest();
  const db = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

// ── Admin password hashing ──────────────────────────────────────────────────────
// The admin password used to sit in settings.json in cleartext, so anyone who could read that
// file (or any endpoint that echoes it) had the credential itself rather than a verifier. Stored
// as scrypt now: "scrypt$<saltB64>$<hashB64>". Async so a login never blocks the event loop the
// Slack side is using. ADMIN_PASSWORD in the environment accepts the same string, so the .env
// copy need not be cleartext either (`npm run hash-password` prints the line).
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 };
const SCRYPT_PREFIX = "scrypt$";

const scryptAsync = (pw, salt) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => (err ? reject(err) : resolve(key)));
  });

export function isHashedPassword(stored) {
  return typeof stored === "string" && stored.startsWith(SCRYPT_PREFIX);
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(pw), salt);
  return `${SCRYPT_PREFIX}${salt.toString("base64")}$${key.toString("base64")}`;
}

// Verify against either format. A stored value that isn't a scrypt string is a legacy cleartext
// password — still accepted (so an existing install keeps working) and compared in constant time;
// callers upgrade it to a hash on the next successful login.
export async function verifyPassword(pw, stored) {
  if (!pw || !stored) return false;
  if (!isHashedPassword(stored)) return timingSafeEqualStr(String(pw), String(stored));

  const [, saltB64, hashB64] = String(stored).split("$");
  if (!saltB64 || !hashB64) return false;
  try {
    const key = await scryptAsync(String(pw), Buffer.from(saltB64, "base64"));
    const expected = Buffer.from(hashB64, "base64");
    // Both are fixed-length scrypt outputs, so a length mismatch means a malformed record, not a
    // guess of the wrong length — no timing signal to protect there.
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}
