// Minimal X.509 v3 certificate ISSUANCE for the egress proxy's per-deployment CA.
//
// Why this exists: the egress proxy terminates TLS for every HTTPS destination a container reaches
// so it can swap placeholders for real credentials, which means minting a leaf certificate per
// hostname on demand, signed by a CA the containers trust. Node can PARSE certificates
// (`crypto.X509Certificate`) but has no API to ISSUE one, and the project takes no new runtime
// dependency and does not shell out to openssl on a hot path. So this file is a small DER encoder
// for exactly the certificate shapes we need — nothing general-purpose:
//   - ECDSA P-256 keys for the CA and every leaf, signed with ecdsa-with-SHA256;
//   - the CA: basicConstraints CA:true pathLen:0 (critical), keyUsage keyCertSign+cRLSign;
//   - a leaf: basicConstraints CA:false, keyUsage digitalSignature, extKeyUsage serverAuth,
//     subjectAltName dNSName (or iPAddress for an IP literal), SKI/AKI.
// The leaf's issuer Name is copied BYTE-FOR-BYTE from the CA certificate's subject so chain
// building never depends on how two encoders canonicalize a Name.
import crypto from "node:crypto";
import { isIP } from "node:net";

// ── DER primitives ─────────────────────────────────────────────────────────────────────────────

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const octets = (buf) => tlv(0x04, buf);
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const utf8 = (text) => tlv(0x0c, Buffer.from(String(text), "utf8"));
const explicit = (n, inner) => tlv(0xa0 | n, inner);
const bitString = (buf, unusedBits = 0) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), buf]));

// A non-negative INTEGER from big-endian bytes, minimally encoded (leading zeros stripped, one
// 0x00 prepended when the high bit would otherwise make it negative).
function uint(bytes) {
  let buf = Buffer.from(bytes);
  while (buf.length > 1 && buf[0] === 0 && buf[1] < 0x80) buf = buf.subarray(1);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}

function oid(dotted) {
  const parts = dotted.split(".").map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

// RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050.
function derTime(date) {
  const iso = date.toISOString(); // 2026-09-26T12:34:56.789Z
  const digits = iso.slice(0, 19).replace(/[-T:]/g, ""); // 20260926123456
  const year = date.getUTCFullYear();
  if (year >= 1950 && year < 2050) return tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, "ascii"));
  return tlv(0x18, Buffer.from(`${digits}Z`, "ascii"));
}

// ── Minimal DER reader (only what we need to lift fields out of our own certificates) ──────────

function readTlv(buf, offset) {
  const tag = buf[offset];
  let len = buf[offset + 1];
  let header = 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    len = 0;
    for (let i = 0; i < count; i += 1) len = len * 256 + buf[offset + 2 + i];
    header += count;
  }
  const start = offset + header;
  return { tag, start, end: start + len, whole: buf.subarray(offset, start + len) };
}

// The subject Name of a certificate, exactly as encoded (the leaf's issuer must match it).
function subjectNameDer(certDer) {
  const cert = readTlv(certDer, 0);
  const tbs = readTlv(certDer, cert.start);
  let at = tbs.start;
  if (certDer[at] === 0xa0) at = readTlv(certDer, at).end; // [0] version
  for (let i = 0; i < 4; i += 1) at = readTlv(certDer, at).end; // serial, sigAlg, issuer, validity
  return Buffer.from(readTlv(certDer, at).whole);
}

// RFC 5280 §4.2.1.2 method (1): SHA-1 of the subjectPublicKey BIT STRING's value bits.
function keyIdentifier(spkiDer) {
  const outer = readTlv(spkiDer, 0);
  const algorithm = readTlv(spkiDer, outer.start);
  const bits = readTlv(spkiDer, algorithm.end);
  return crypto.createHash("sha1").update(spkiDer.subarray(bits.start + 1, bits.end)).digest();
}

// ── Certificate pieces ─────────────────────────────────────────────────────────────────────────

const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

const SIGNATURE_ALGORITHM = seq(oid(OID.ecdsaWithSha256));
const CN_MAX = 64; // ub-common-name (RFC 5280 Appendix A)

function nameDer({ commonName, organization }) {
  const rdns = [];
  if (organization) rdns.push(set(seq(oid(OID.organization), utf8(organization))));
  if (commonName) rdns.push(set(seq(oid(OID.commonName), utf8(commonName))));
  return seq(...rdns);
}

function extension(id, critical, valueDer) {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(valueDer));
}

function randomSerial() {
  const bytes = crypto.randomBytes(16);
  bytes[0] &= 0x7f; // positive
  if (bytes[0] === 0) bytes[0] = 0x01; // and minimally encoded at a fixed 16 bytes
  return bytes;
}

// 169.254.169.254 → 4 bytes, "::1" → 16 bytes (iPAddress GeneralName octets).
function ipBytes(ip) {
  if (isIP(ip) === 4) return Buffer.from(ip.split(".").map(Number));
  // A dotted IPv4 tail ("::ffff:1.2.3.4") becomes two hex groups before "::" is expanded.
  const hex = ip.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c, d) =>
    `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`);
  const [left, right] = hex.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const groups = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  const out = Buffer.alloc(16);
  groups.forEach((group, i) => out.writeUInt16BE(parseInt(group, 16), i * 2));
  return out;
}

function sanDer(hostname) {
  if (isIP(hostname)) return seq(tlv(0x87, ipBytes(hostname)));
  return seq(tlv(0x82, Buffer.from(hostname, "ascii")));
}

function newEcKeyPair() {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function signCertificate({ serial, issuerDer, subjectDer, notBefore, notAfter, spkiDer, extensions, signingKey }) {
  const tbs = seq(
    explicit(0, uint([2])), // v3
    uint(serial),
    SIGNATURE_ALGORITHM,
    issuerDer,
    seq(derTime(notBefore), derTime(notAfter)),
    subjectDer,
    spkiDer,
    explicit(3, seq(...extensions)),
  );
  const signature = crypto.sign("sha256", tbs, { key: signingKey, dsaEncoding: "der" });
  return seq(tbs, SIGNATURE_ALGORITHM, bitString(signature));
}

function toPem(der) {
  const lines = der.toString("base64").match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKDATE_MS = 60 * 60 * 1000; // tolerate an hour of client clock skew

// ── Public API ─────────────────────────────────────────────────────────────────────────────────

// A self-signed ECDSA P-256 CA certificate. `days` may be fractional.
export function createCaCertificate({ commonName = "ChannelGate egress CA", organization = "ChannelGate", days = 3650, now = new Date() } = {}) {
  const { publicKey, privateKey } = newEcKeyPair();
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const keyId = keyIdentifier(spkiDer);
  const name = nameDer({ commonName: String(commonName).slice(0, CN_MAX), organization });
  const der = signCertificate({
    serial: randomSerial(),
    issuerDer: name,
    subjectDer: name,
    notBefore: new Date(now.getTime() - BACKDATE_MS),
    notAfter: new Date(now.getTime() + days * DAY_MS),
    spkiDer,
    extensions: [
      extension(OID.basicConstraints, true, seq(bool(true), uint([0]))),
      // keyCertSign (bit 5) + cRLSign (bit 6) → 0000 0110, one trailing unused bit.
      extension(OID.keyUsage, true, bitString(Buffer.from([0x06]), 1)),
      extension(OID.subjectKeyIdentifier, false, octets(keyId)),
    ],
    signingKey: privateKey,
  });
  return { certPem: toPem(der), keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

// Internal form used by the CA store: parsed CA cert + KeyObject, so a busy proxy does not re-parse
// PEM per leaf. `hostname` must already be validated (ca.js does it). `days` may be fractional.
export function issueLeafWith({ caCert, caKey, hostname, days = 1, now = new Date() }) {
  const { publicKey, privateKey } = newEcKeyPair();
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const caSpki = caCert.publicKey.export({ type: "spki", format: "der" });
  const caNotAfter = new Date(caCert.validTo);
  const wanted = new Date(now.getTime() + days * DAY_MS);
  const notAfter = wanted > caNotAfter ? caNotAfter : wanted; // never outlive the issuer
  const longName = hostname.length > CN_MAX;
  const der = signCertificate({
    serial: randomSerial(),
    issuerDer: subjectNameDer(caCert.raw),
    // A hostname longer than the CN bound gets an empty subject; the SAN then carries identity
    // and must be critical (RFC 5280 §4.2.1.6).
    subjectDer: nameDer({ commonName: longName ? "" : hostname }),
    notBefore: new Date(now.getTime() - BACKDATE_MS),
    notAfter,
    spkiDer,
    extensions: [
      extension(OID.basicConstraints, true, seq()),
      // digitalSignature (bit 0) → 1000 0000, seven trailing unused bits. ECDHE needs nothing more.
      extension(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)),
      extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      extension(OID.subjectAltName, longName, sanDer(hostname)),
      extension(OID.subjectKeyIdentifier, false, octets(keyIdentifier(spkiDer))),
      extension(OID.authorityKeyIdentifier, false, seq(tlv(0x80, keyIdentifier(caSpki)))),
    ],
    signingKey: caKey,
  });
  return { certPem: toPem(der), keyPem: privateKey.export({ type: "pkcs8", format: "pem" }), notAfter };
}

// A leaf for `hostname` (a DNS name or an IP literal) signed by the given CA PEMs.
export function issueLeafCertificate({ caCertPem, caKeyPem, hostname, days = 1, now = new Date() }) {
  const caCert = new crypto.X509Certificate(caCertPem);
  const caKey = crypto.createPrivateKey(caKeyPem);
  const { certPem, keyPem } = issueLeafWith({ caCert, caKey, hostname: String(hostname).toLowerCase(), days, now });
  return { certPem, keyPem };
}
