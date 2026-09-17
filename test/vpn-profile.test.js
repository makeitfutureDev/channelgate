import test from "node:test";
import assert from "node:assert/strict";
import { normalizeVpnProfile, validateVpnTarget } from "../src/gateway/vpn-profile.js";

// Non-functional fixture material: no real credentials, certificate or private key.
const pem = (kind, label) => `<${kind}>\n-----BEGIN ${label}-----\nVEVTVA==\n-----END ${label}-----\n</${kind}>`;
const profile = `client\ndev tun\nproto tcp\nremote vpn.example.test 8443\nverify-x509-name "VPN server" name\nroute remote_host 255.255.255.255 net_gateway\nresolv-retry infinite\nnobind\npersist-key\npersist-tun\nauth-user-pass\ncipher AES-256-CBC\nauth SHA512\nroute-delay 4\nverb 3\nreneg-sec 0\n${pem("ca", "CERTIFICATE")}\n${pem("cert", "CERTIFICATE")}\n${pem("key", "PRIVATE KEY")}\n`;
const target = { dbHost: "10.42.0.7", dbPort: 3306 };
const normalize = (text = profile, options = target) => normalizeVpnProfile(text, options);

test("normalizes a legacy TCP client to a database-only generated config", () => {
  const result = normalize();
  assert.deepEqual(result.remote, { host: "vpn.example.test", port: 8443, proto: "tcp-client" });
  assert.equal(result.hasClientKey, true);
  for (const line of ["dev tun0", "proto tcp-client", "auth-user-pass /vpn/auth", "auth-nocache", "route-nopull", "script-security 1", "remote-cert-tls server", "route 10.42.0.7 255.255.255.255 vpn_gateway", "data-ciphers AES-256-GCM:AES-128-GCM:AES-256-CBC", "data-ciphers-fallback AES-256-CBC", 'verify-x509-name "VPN server" "name"']) {
    assert.ok(result.config.split("\n").includes(line), line);
  }
  assert.equal(result.config.split("\n").filter((line) => line.startsWith("route ")).length, 2);
});

test("accepts CRLF, comments, explicit tcp-client and safe escaped certificate identity", () => {
  const result = normalize(profile.replace("proto tcp", "proto tcp-client # note").replace('"VPN server"', '"VPN \\"server\\""').replaceAll("\n", "\r\n"));
  assert.match(result.config, /verify-x509-name "VPN \\"server\\"" "name"/);
});

test("supports an inline TLS static key and checks its direction", () => {
  const key = `-----BEGIN OpenVPN Static key V1-----\n${"a".repeat(32)}\n`.replace(/a{32}\n$/, `${(`${"a".repeat(32)}\n`).repeat(16)}`) + "-----END OpenVPN Static key V1-----";
  assert.match(normalize(`${profile}<tls-auth>\n# static key\n${key}\n</tls-auth>\nkey-direction 1\n`).config, /key-direction "1"/);
  assert.match(normalize(`${profile}<tls-crypt>\n${key}\n</tls-crypt>\n`).config, /<tls-crypt>/);
  assert.throws(() => normalize(`${profile}key-direction 1\n`), /requires tls-auth/);
  assert.throws(() => normalize(`${profile}<tls-auth>\n${key}\n</tls-auth>\n<tls-crypt>\n${key}\n</tls-crypt>\n`), /conflicting/);
});

test("rejects executable hooks, external files, broad routes and connection overrides without echoing inputs", () => {
  for (const directive of ["up /secret-path", "plugin /secret-path", "config /secret-path", "management 127.0.0.1 1", "log /secret-path", "ca /secret-path", "auth-user-pass /secret-path", "redirect-gateway def1", "route 0.0.0.0 0.0.0.0", "script-security 2", "setenv opt up /secret-path", "tls-verify /secret-path", "http-proxy attacker.test 80", "remote-random", "<connection>\nremote attacker.test 443\n</connection>"]) {
    assert.throws(() => normalize(`${profile}${directive}\n`), (error) => error.message.startsWith("Unsupported VPN profile:") && !error.message.includes("secret-path"), directive);
  }
});

test("rejects malformed quoting, duplicate directives and incompatible transports", () => {
  for (const text of [profile + "remote attacker.test 443\n", profile.replace("proto tcp", "proto udp"), profile.replace("dev tun", "dev tap"), profile.replace("8443", "0"), profile.replace("8443", "65536"), profile.replace("vpn.example.test", "-bad.test"), profile.replace("vpn.example.test", "127.000.0.1"), profile.replace('"VPN server"', '"unclosed'), profile.replace('"VPN server"', '"bad\\nname"'), profile + "remote-cert-tls client\n", profile + "cipher BAD\n", profile + "\0"]) {
    assert.throws(() => normalize(text), /Unsupported VPN profile/);
  }
});

test("requires bounded, well-formed inline credentials and never admits hidden directives", () => {
  for (const text of [profile.replace(pem("key", "PRIVATE KEY"), ""), profile.replace("</key>", ""), profile + pem("key", "PRIVATE KEY"), profile.replace("VEVTVA==", "up /secret-path"), profile.replace("VEVTVA==", "</ca>\nup /secret-path\n<ca>"), profile.replace("VEVTVA==", "a".repeat(100_000)), "#".repeat(300_000), profile.replace("client\n", ""), profile.replace("-----END PRIVATE KEY-----", "-----END CERTIFICATE-----")]) {
    assert.throws(() => normalize(text), /Unsupported VPN profile/);
  }
});

test("validates a literal database target and port before rendering", () => {
  assert.deepEqual(validateVpnTarget("10.42.0.7", "3306"), target);
  for (const dbHost of ["db.example.test", "10.0.0.1\nup /bin/sh", "0.0.0.0", "127.0.0.1", "224.0.0.1", "255.255.255.255", "::1", "10.01.0.1"]) {
    assert.throws(() => normalize(profile, { ...target, dbHost }), /database/);
  }
  for (const dbPort of [0, -1, 65536, 1.5, "3306\n", "", true, null]) {
    assert.throws(() => normalize(profile, { ...target, dbPort }), /database port/);
  }
});
