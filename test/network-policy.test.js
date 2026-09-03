import test from "node:test";
import assert from "node:assert/strict";
import { compileNetworkPolicy, requestedNetworkPolicy, NETWORK_MODES } from "../src/engines/network-policy.js";
import { adapterFor } from "../src/engines/registry.js";

// Since the container runtime is the only runtime, a channel's network is a SWITCH: the container
// either has network or it has none. The compiler no longer knows engine ids or domain lists: the
// caller (each adapter's compileConfinement) passes its OWN declared supports.networkModes, so the
// manifest is the single source of truth. These tests exercise the compiler exactly as the
// adapters drive it.
const modesOf = (engine) => adapterFor(engine).supports.networkModes;

test("the policy is a two-state switch — the approved-domain and unrestricted tiers are gone with the host sandbox", () => {
  assert.deepEqual(NETWORK_MODES, { OFF: "off", ON: "on" });
  assert.equal(requestedNetworkPolicy({ allowNetwork: false }), "off");
  assert.equal(requestedNetworkPolicy({ allowNetwork: true }), "on");
  assert.equal(requestedNetworkPolicy({}), "off", "a channel that says nothing gets no network");
  for (const engine of ["claude", "codex"]) {
    assert.deepEqual(modesOf(engine), ["off", "on"], `${engine} declares exactly the two states`);
  }
});

test("semantic network policy compiles per declared capability without silently broadening access", () => {
  assert.deepEqual(compileNetworkPolicy({ engine: "claude", supportedModes: modesOf("claude") }), { mode: NETWORK_MODES.OFF, supported: true });
  assert.deepEqual(compileNetworkPolicy({ engine: "codex", supportedModes: modesOf("codex") }), { mode: NETWORK_MODES.OFF, supported: true });
  const expected = { mode: NETWORK_MODES.ON, supported: true };
  assert.deepEqual(compileNetworkPolicy({ engine: "claude", allowNetwork: true, supportedModes: modesOf("claude") }), expected);
  assert.deepEqual(compileNetworkPolicy({ engine: "codex", allowNetwork: true, supportedModes: modesOf("codex") }), expected);
  // Nothing an old caller passes can widen the result: a domain list is not a mode.
  const withDomains = compileNetworkPolicy({ engine: "claude", allowNetwork: true, allowedDomains: ["github.com"], supportedModes: modesOf("claude") });
  assert.deepEqual(withDomains, expected);
  assert.equal("domains" in withDomains, false);
});

test("an engine that does not declare the on state is refused, and the default is off-only", () => {
  // opencode declares ["off"] — turning the network on must refuse through the same generic path.
  const oc = compileNetworkPolicy({ engine: "opencode", allowNetwork: true, supportedModes: modesOf("opencode") });
  assert.equal(oc.mode, NETWORK_MODES.ON, "the requested state is still named, so the refusal is legible");
  assert.equal(oc.supported, false);
  assert.match(oc.reason, /cannot run with the network on/i);
  assert.deepEqual(compileNetworkPolicy({ engine: "opencode", supportedModes: modesOf("opencode") }), { mode: NETWORK_MODES.OFF, supported: true });
  // A caller that passes nothing gets the fail-closed default (off-only), not Claude's modes.
  const bare = compileNetworkPolicy({ engine: "mystery", allowNetwork: true });
  assert.equal(bare.supported, false);
  assert.match(bare.reason, /^mystery cannot run/);
});

test("an explicit admin bypass is reported honestly by the adapter, and the network switch is still what the container gets", () => {
  // The bypass lifts the ENGINE's own sandbox; it does not invent a third network state. The
  // container's network is decided by the channel's switch alone, bypass or not.
  for (const engine of ["claude", "codex"]) {
    const off = adapterFor(engine).compileConfinement({ dangerouslySkip: true, allowNetwork: false });
    assert.equal(off.supported, true);
    assert.equal(off.bypass, true);
    assert.deepEqual(off.network, { mode: NETWORK_MODES.OFF, supported: true });
    const on = adapterFor(engine).compileConfinement({ dangerouslySkip: true, allowNetwork: true, writable: true });
    assert.equal(on.bypass, true);
    assert.equal(on.writable, true);
    assert.deepEqual(on.network, { mode: NETWORK_MODES.ON, supported: true });
  }
});
