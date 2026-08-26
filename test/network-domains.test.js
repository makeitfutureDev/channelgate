import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNetworkDomain, normalizeNetworkDomains } from "../src/util/network-domains.js";

test("approved network domains normalize once for every engine", () => {
  assert.equal(normalizeNetworkDomain(" API.GitHub.com. "), "api.github.com");
  assert.equal(normalizeNetworkDomain("*.Example.com"), "*.example.com");
  assert.deepEqual(
    normalizeNetworkDomains(["github.com", "GITHUB.COM.", "*.githubusercontent.com"]),
    ["github.com", "*.githubusercontent.com"],
  );
});

test("approved network domains reject broad, local, address, and URL-shaped entries", () => {
  for (const value of [
    "*", "localhost", "internal", "127.0.0.1", "::1", "10.0.0.1",
    "https://github.com", "github.com:443", "github.com/path", "user@github.com", "**.example.com",
    "-bad.example", "bad_.example.com", "*.localhost",
  ]) {
    assert.throws(() => normalizeNetworkDomain(value), Error, value);
  }
});

test("an approved policy cannot compile an empty allowlist", () => {
  assert.throws(() => normalizeNetworkDomains([]), /at least one/i);
  assert.deepEqual(normalizeNetworkDomains([], { allowEmpty: true }), []);
});
