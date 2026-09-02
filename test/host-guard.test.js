import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { hostAllowed, allowedHosts } = await import("../src/web/security.js");

// DNS-rebinding defence. A browser scopes same-origin by HOSTNAME, so a page on evil.example
// whose DNS flips to 127.0.0.1 talks to the admin API as same-origin — the loopback bind stops
// nothing, and on a passwordless install there is no cookie to be missing. The Host header is
// what still carries the attacker's name, so that's what we check.

const req = (headers) => ({ headers });

test("loopback hosts are allowed in all their spellings", () => {
  for (const host of ["localhost:4747", "127.0.0.1:4747", "[::1]:4747", "127.0.0.1", "localhost"]) {
    assert.ok(hostAllowed(req({ host })), `${host} must be allowed`);
  }
});

test("a rebound attacker hostname is refused", () => {
  assert.equal(hostAllowed(req({ host: "evil.example:4747" })), false);
  assert.equal(hostAllowed(req({ host: "gateway.attacker.test" })), false);
});

test("a cross-origin fetch from an attacker page is refused even with a loopback Host", () => {
  // The rebinding case: Host looks local, but the browser discloses the real page origin.
  assert.equal(hostAllowed(req({ host: "127.0.0.1:4747", origin: "https://evil.example" })), false);
});

test("a same-origin browser request passes", () => {
  assert.ok(hostAllowed(req({ host: "localhost:4747", origin: "http://localhost:4747" })));
});

test("an unparseable Origin is refused rather than guessed", () => {
  assert.equal(hostAllowed(req({ host: "localhost:4747", origin: "not a url" })), false);
});

test("a request with no Host header (curl/automation) is not a rebinding victim and passes", () => {
  assert.ok(hostAllowed(req({})));
});

test("an explicitly allowed tunnel hostname passes; others still don't", () => {
  const allowed = new Set([...allowedHosts(), "gateway.example.com"]);
  assert.ok(hostAllowed(req({ host: "gateway.example.com", origin: "https://gateway.example.com" }), allowed));
  assert.equal(hostAllowed(req({ host: "other.example.com" }), allowed), false);
});

test("the default allowlist covers loopback without needing configuration", () => {
  const allowed = allowedHosts();
  assert.ok(allowed.has("localhost"));
  assert.ok(allowed.has("127.0.0.1"));
  assert.ok(allowed.has("::1"));
});

// A tunnel hostname is typed into a settings field by a human. When the value it produced granted
// nothing, EVERY /api/* call 403'd and the Settings page that would fix it sat behind the same
// guard — a closed loop with no in-product way out. These cases pin the forms that must work.
test("publicUrl grants its hostname however the operator spelled it", () => {
  const forms = {
    "https://gateway.example.com": "gateway.example.com",
    "https://gateway.example.com/": "gateway.example.com",
    "http://gateway.example.com:8443": "gateway.example.com",
    "gateway.example.com": "gateway.example.com", // scheme-less: the obvious thing to type
    "gateway.example.com/admin": "gateway.example.com",
    "  https://gateway.example.com  ": "gateway.example.com",
  };
  const previous = process.env.GATEWAY_PUBLIC_URL;
  try {
    for (const [value, expected] of Object.entries(forms)) {
      process.env.GATEWAY_PUBLIC_URL = value;
      const allowed = allowedHosts();
      assert.ok(allowed.has(expected), `${JSON.stringify(value)} must grant ${expected}`);
      assert.ok(hostAllowed(req({ host: expected, origin: `https://${expected}` }), allowed));
      // Granting a host must never grant its neighbours.
      assert.equal(hostAllowed(req({ host: "other.example.com" }), allowed), false);
    }
    // Genuinely unparseable stays fail-closed rather than guessing a host.
    process.env.GATEWAY_PUBLIC_URL = "http://";
    assert.equal(hostAllowed(req({ host: "gateway.example.com" }), allowedHosts()), false);
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_PUBLIC_URL;
    else process.env.GATEWAY_PUBLIC_URL = previous;
  }
});
