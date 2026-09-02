import test from "node:test";
import assert from "node:assert/strict";
import { compileNetworkPolicy, NETWORK_MODES } from "../src/engines/network-policy.js";
import { adapterFor } from "../src/engines/registry.js";

// The compiler no longer knows engine ids: the caller (each adapter's compileConfinement) passes
// its OWN declared supports.networkModes, so the manifest is the single source of truth. These
// tests exercise the compiler exactly as the adapters drive it.
const modesOf = (engine) => adapterFor(engine).supports.networkModes;

test("semantic network policy compiles per declared capability without silently broadening access", () => {
  assert.deepEqual(compileNetworkPolicy({ engine: "claude", supportedModes: modesOf("claude") }), { mode: NETWORK_MODES.OFF, supported: true });
  assert.deepEqual(compileNetworkPolicy({ engine: "codex", supportedModes: modesOf("codex") }), { mode: NETWORK_MODES.OFF, supported: true });
  const allowedDomains = ["GitHub.com.", "*.githubusercontent.com", "github.com"];
  const expected = { mode: NETWORK_MODES.APPROVED, supported: true, domains: ["github.com", "*.githubusercontent.com"] };
  assert.deepEqual(compileNetworkPolicy({ engine: "claude", allowNetwork: true, allowedDomains, supportedModes: modesOf("claude") }), expected);
  assert.deepEqual(compileNetworkPolicy({ engine: "codex", allowNetwork: true, allowedDomains, supportedModes: modesOf("codex") }), expected);

  for (const engine of ["claude", "codex"]) {
    const missing = compileNetworkPolicy({ engine, allowNetwork: true, allowedDomains: [], supportedModes: modesOf(engine) });
    assert.equal(missing.mode, NETWORK_MODES.APPROVED);
    assert.equal(missing.supported, false);
    assert.match(missing.reason, /no safe allowlist/i);
  }
});

test("an engine that does not declare approved mode is refused, and the default is off-only", () => {
  // opencode declares ["off"] — approved must refuse through the same generic path.
  const oc = compileNetworkPolicy({ engine: "opencode", allowNetwork: true, allowedDomains: ["github.com"], supportedModes: modesOf("opencode") });
  assert.equal(oc.supported, false);
  assert.match(oc.reason, /cannot enforce/i);
  // A caller that passes nothing gets the fail-closed default (off-only), not Claude's modes.
  const bare = compileNetworkPolicy({ engine: "mystery", allowNetwork: true, allowedDomains: ["github.com"] });
  assert.equal(bare.supported, false);
});

test("explicit admin sandbox bypass is honestly unrestricted for either engine", () => {
  for (const engine of ["claude", "codex"]) {
    assert.deepEqual(
      compileNetworkPolicy({ engine, allowNetwork: false, dangerouslySkip: true, supportedModes: modesOf(engine) }),
      { mode: NETWORK_MODES.UNRESTRICTED, supported: true },
    );
  }
});
