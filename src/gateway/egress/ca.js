// The per-deployment egress CA and its leaf-certificate cache.
//
// Why: the egress proxy terminates TLS so it can swap placeholders, which needs a CA every channel
// container trusts (its `ca.pem` is mounted into the container and named by NODE_EXTRA_CA_CERTS,
// SSL_CERT_FILE, GIT_SSL_CAINFO and friends). One CA per deployment, created on first use and kept
// forever: rotating it means every container and every operator who trusted it must re-trust.
//
// Layout (`dir`, normally ~/.channelgate/config/egress-ca/): the directory 0700, `ca.key` 0600 (the
// signing key — it never leaves the daemon), `ca.pem` 0644 (public). Modes are re-applied on every
// load, like src/config/harden.js does for the other secret files, because a `mode` passed to a
// write only applies when the file is CREATED.
//
// Leaves are minted on demand per hostname (ECDSA P-256, 24 h) and kept in an LRU (512 entries),
// re-minted an hour before they expire. The returned entry object is stable while cached, so a
// caller may key its own derived state (a tls SecureContext) on it with a WeakMap.
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCaCertificate, issueLeafWith } from "./x509.js";
import { isValidDestinationHost } from "./policy.js";
import { normalizeHost } from "./rules.js";

const HOUR_MS = 60 * 60 * 1000;
export const LEAF_CACHE_MAX = 512;
export const LEAF_VALIDITY_HOURS = 24;
export const LEAF_RENEW_BEFORE_MS = HOUR_MS;

function writeAtomic(file, contents, mode) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, contents, { mode, flag: "wx" });
  chmodSync(temp, mode);
  renameSync(temp, file);
}

function createFiles(keyFile, certFile, { commonName }) {
  const { certPem, keyPem } = createCaCertificate({
    commonName: commonName || `ChannelGate egress CA ${crypto.randomBytes(4).toString("hex")}`,
    organization: "ChannelGate",
    days: 3650,
  });
  rmSync(certFile, { force: true }); // a stale cert must never pair with the new key
  writeAtomic(keyFile, keyPem, 0o600);
  writeAtomic(certFile, certPem, 0o644); // written last: its presence marks a complete CA
}

// Load the CA under `dir`, creating it on first call. Throws when the stored key and certificate do
// not belong together (an operator must look: silently replacing a trusted CA breaks every client).
export function loadOrCreateEgressCa({ dir, commonName, cacheMax = LEAF_CACHE_MAX, leafHours = LEAF_VALIDITY_HOURS, renewBeforeMs = LEAF_RENEW_BEFORE_MS, now = () => Date.now() }) {
  if (!dir) throw new Error("loadOrCreateEgressCa: dir is required");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const keyFile = path.join(dir, "ca.key");
  const certFile = path.join(dir, "ca.pem");
  if (!existsSync(keyFile) || !existsSync(certFile)) createFiles(keyFile, certFile, { commonName });
  chmodSync(keyFile, 0o600);
  chmodSync(certFile, 0o644);

  const certPem = readFileSync(certFile, "utf8");
  const caCert = new crypto.X509Certificate(certPem);
  const caKey = crypto.createPrivateKey(readFileSync(keyFile, "utf8"));
  if (!caCert.checkPrivateKey(caKey)) throw new Error(`egress CA at ${dir}: ca.key does not match ca.pem`);
  if (!caCert.ca) throw new Error(`egress CA at ${dir}: ca.pem is not a CA certificate`);

  const cache = new Map(); // hostname → { key, cert, expiresAt } in LRU order (oldest first)

  function mint(hostname) {
    const { certPem: cert, keyPem: key, notAfter } = issueLeafWith({ caCert, caKey, hostname, days: leafHours / 24, now: new Date(now()) });
    return { key, cert, expiresAt: notAfter.getTime() };
  }

  // → { key, cert } PEM strings for tls.createSecureContext. Throws on an invalid hostname.
  function leafFor(hostname) {
    const host = normalizeHost(hostname);
    if (!isValidDestinationHost(host)) throw new Error("egress CA: refusing to mint a certificate for an invalid host name");
    let entry = cache.get(host);
    if (entry && entry.expiresAt - renewBeforeMs > now()) {
      cache.delete(host);
      cache.set(host, entry); // refresh LRU position
      return entry;
    }
    entry = mint(host);
    cache.delete(host);
    cache.set(host, entry);
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
    return entry;
  }

  return {
    dir,
    certPem,
    certPath: certFile,
    expiresAt: new Date(caCert.validTo).getTime(),
    leafFor,
    get cacheSize() { return cache.size; },
  };
}
