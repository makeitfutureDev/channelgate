// The egress CA (src/gateway/egress/x509.js + ca.js). Node can parse certificates but not issue
// them, so x509.js is a hand-written DER encoder; these tests prove its output is REAL: Node's
// parser accepts it, the chain verifies, a TLS client with only the CA as trust anchor completes a
// verified handshake against a leaf, and (when installed) openssl agrees independently.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import tls from "node:tls";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const { createCaCertificate, issueLeafCertificate } = await import("../src/gateway/egress/x509.js");
const { loadOrCreateEgressCa } = await import("../src/gateway/egress/ca.js");

const mode = (file) => statSync(file).mode & 0o777;

function handshake({ certPem, keyPem, caPem, servername }) {
  return new Promise((resolve, reject) => {
    const server = tls.createServer({ key: keyPem, cert: certPem }, (socket) => socket.end("hello"));
    server.listen(0, "127.0.0.1", () => {
      const client = tls.connect({ host: "127.0.0.1", port: server.address().port, ca: [caPem], servername, rejectUnauthorized: true });
      let data = "";
      client.on("data", (chunk) => { data += chunk; });
      client.on("end", () => { server.close(); resolve({ authorized: client.authorized, data }); });
      client.on("error", (err) => { server.close(); reject(err); });
    });
  });
}

test("a CA and its leaves parse, chain and match their host", () => {
  const ca = createCaCertificate({ commonName: "ChannelGate egress CA test", organization: "ChannelGate", days: 30 });
  const caCert = new crypto.X509Certificate(ca.certPem);
  assert.equal(caCert.ca, true);
  assert.match(caCert.subject, /CN=ChannelGate egress CA test/);
  assert.match(caCert.subject, /O=ChannelGate/);
  assert.equal(caCert.checkIssued(caCert), true, "self-signed");
  assert.equal(caCert.verify(caCert.publicKey), true);
  assert.equal(caCert.checkPrivateKey(crypto.createPrivateKey(ca.keyPem)), true);
  assert.equal(caCert.publicKey.asymmetricKeyDetails.namedCurve, "prime256v1");

  for (const hostname of ["api.github.com", "a-very-long-label-that-pushes-this-name-past-the-sixty-four-char-cn.example.com"]) {
    const leaf = issueLeafCertificate({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, hostname, days: 1 });
    const cert = new crypto.X509Certificate(leaf.certPem);
    assert.equal(cert.ca, false);
    assert.equal(cert.checkIssued(caCert), true);
    assert.equal(cert.verify(caCert.publicKey), true);
    assert.equal(cert.checkHost(hostname), hostname);
    assert.equal(cert.checkHost("other.example"), undefined);
    assert.equal(cert.checkPrivateKey(crypto.createPrivateKey(leaf.keyPem)), true);
    assert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.1"], "extKeyUsage serverAuth");
    const lifetime = new Date(cert.validTo) - new Date(cert.validFrom);
    assert.ok(lifetime > 24 * 3600e3 && lifetime <= 26 * 3600e3, "one day plus the skew backdate");
  }

  const ipLeaf = new crypto.X509Certificate(issueLeafCertificate({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, hostname: "93.184.215.14" }).certPem);
  assert.equal(ipLeaf.checkIP("93.184.215.14"), "93.184.215.14");
  assert.equal(ipLeaf.subjectAltName, "IP Address:93.184.215.14");
  const v6Leaf = new crypto.X509Certificate(issueLeafCertificate({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, hostname: "2001:db8::1" }).certPem);
  assert.equal(v6Leaf.checkIP("2001:db8::1"), "2001:db8::1");

  // A leaf never outlives its issuer.
  const shortCa = createCaCertificate({ days: 0.5 });
  const capped = new crypto.X509Certificate(issueLeafCertificate({ caCertPem: shortCa.certPem, caKeyPem: shortCa.keyPem, hostname: "x.example", days: 5 }).certPem);
  assert.equal(capped.validTo, new crypto.X509Certificate(shortCa.certPem).validTo);
});

test("a TLS client trusting only the CA completes a verified handshake against a leaf", async () => {
  const ca = createCaCertificate({ days: 30 });
  const leaf = issueLeafCertificate({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, hostname: "upstream.test" });
  const ok = await handshake({ certPem: leaf.certPem, keyPem: leaf.keyPem, caPem: ca.certPem, servername: "upstream.test" });
  assert.deepEqual(ok, { authorized: true, data: "hello" });
  await assert.rejects(
    handshake({ certPem: leaf.certPem, keyPem: leaf.keyPem, caPem: ca.certPem, servername: "other.test" }),
    /altnames|Hostname/i,
    "the wrong name is rejected",
  );
  const stranger = createCaCertificate({ days: 30 });
  await assert.rejects(
    handshake({ certPem: leaf.certPem, keyPem: leaf.keyPem, caPem: stranger.certPem, servername: "upstream.test" }),
    /self.signed|unable to (get|verify)/i,
    "another CA does not vouch for it",
  );
});

const OPENSSL = ["/usr/bin/openssl", "/usr/local/bin/openssl"].find((p) => existsSync(p));

test("openssl independently verifies the chain and decodes the extensions", { skip: OPENSSL ? false : "openssl not installed" }, () => {
  const dir = tempDir("cg-egress-openssl-");
  const ca = createCaCertificate({ commonName: "ChannelGate egress CA openssl", days: 30 });
  const leaf = issueLeafCertificate({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, hostname: "api.github.com" });
  writeFileSync(path.join(dir, "ca.pem"), ca.certPem);
  writeFileSync(path.join(dir, "leaf.pem"), leaf.certPem);

  const verify = spawnSync(OPENSSL, ["verify", "-CAfile", path.join(dir, "ca.pem"), path.join(dir, "leaf.pem")], { encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /leaf\.pem: OK/);

  const leafText = spawnSync(OPENSSL, ["x509", "-noout", "-text", "-in", path.join(dir, "leaf.pem")], { encoding: "utf8" });
  assert.equal(leafText.status, 0, leafText.stderr);
  assert.match(leafText.stdout, /Version: 3/);
  assert.match(leafText.stdout, /Signature Algorithm: ecdsa-with-SHA256/);
  assert.match(leafText.stdout, /CA:FALSE/);
  assert.match(leafText.stdout, /Digital Signature/);
  assert.match(leafText.stdout, /TLS Web Server Authentication/);
  assert.match(leafText.stdout, /DNS:api\.github\.com/);
  assert.match(leafText.stdout, /X509v3 Authority Key Identifier/);

  const caText = spawnSync(OPENSSL, ["x509", "-noout", "-text", "-in", path.join(dir, "ca.pem")], { encoding: "utf8" });
  assert.match(caText.stdout, /CA:TRUE, pathlen:0/);
  assert.match(caText.stdout, /Certificate Sign, CRL Sign/);
});

test("the CA store creates 0700/0600/0644 files once and reuses them", () => {
  const dir = path.join(tempDir("cg-egress-ca-"), "egress-ca");
  const first = loadOrCreateEgressCa({ dir });
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.join(dir, "ca.key")), 0o600);
  assert.equal(mode(path.join(dir, "ca.pem")), 0o644);
  assert.equal(first.certPem, readFileSync(path.join(dir, "ca.pem"), "utf8"));
  assert.equal(first.certPath, path.join(dir, "ca.pem"));
  assert.ok(first.expiresAt > Date.now() + 3000 * 24 * 3600e3);

  const second = loadOrCreateEgressCa({ dir });
  assert.equal(second.certPem, first.certPem, "the same CA on every later load");

  // Modes are repaired on load, like harden.js does for the other secret files.
  chmodSync(path.join(dir, "ca.key"), 0o644);
  loadOrCreateEgressCa({ dir });
  assert.equal(mode(path.join(dir, "ca.key")), 0o600);

  // A key that does not belong to the certificate is an operator problem, never a silent re-key.
  writeFileSync(path.join(dir, "ca.key"), createCaCertificate().keyPem);
  assert.throws(() => loadOrCreateEgressCa({ dir }), /does not match/);
});

test("leafFor mints per host, caches in an LRU, re-mints before expiry and rejects bad names", () => {
  let clock = Date.now();
  const store = loadOrCreateEgressCa({ dir: path.join(tempDir("cg-egress-leaf-"), "ca"), cacheMax: 2, now: () => clock });
  const caCert = new crypto.X509Certificate(store.certPem);

  const a = store.leafFor("API.GitHub.com.");
  assert.ok(a.key.includes("PRIVATE KEY") && a.cert.includes("BEGIN CERTIFICATE"));
  assert.doesNotThrow(() => tls.createSecureContext({ key: a.key, cert: a.cert }));
  const cert = new crypto.X509Certificate(a.cert);
  assert.equal(cert.checkHost("api.github.com"), "api.github.com");
  assert.equal(cert.checkIssued(caCert), true);
  assert.equal(store.leafFor("api.github.com"), a, "cached entry object is reused");

  const b = store.leafFor("b.example");
  store.leafFor("api.github.com"); // touch a → b is now the oldest
  store.leafFor("c.example");
  assert.equal(store.cacheSize, 2);
  assert.equal(store.leafFor("api.github.com"), a, "the recently used entry survived eviction");
  assert.notEqual(store.leafFor("b.example"), b, "the evicted entry is minted again");

  clock += 23 * 3600e3 + 60e3; // inside the last hour of a's 24 h validity
  const renewed = store.leafFor("api.github.com");
  assert.notEqual(renewed, a);
  assert.ok(renewed.expiresAt > a.expiresAt);

  assert.ok(store.leafFor("10.0.0.1").cert);
  for (const bad of ["*.example.com", "bad host", "", "a..b", "-x.example", "x".repeat(254)]) {
    assert.throws(() => store.leafFor(bad), /invalid host name/, JSON.stringify(bad));
  }
});
