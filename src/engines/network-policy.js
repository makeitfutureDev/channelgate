// Semantic network policy compiled into what each engine is TOLD. Since the container runtime is
// the only runtime, a channel's network is a switch with two states: "on" means the channel is
// meant to use the internet, "off" means it is not. There is no per-domain allow-list any more —
// the host sandbox that compiled one is gone — so an engine either supports "on" or refuses it.
//
// IMPORTANT — the switch is ADVISORY, not a cut-off. Every channel's container runs on the default
// bridge network and the gateway polices no egress per channel, so "off" does NOT run the
// container without a network: it states the channel's intent, which the engines are told and are
// expected to respect. The container-side egress proxy that will actually enforce it is a later
// slice (docs/OPERATIONS.md → "Egress is not policed per channel"). Anything that renders or logs
// a policy must read NETWORK_POLICY_ENFORCED rather than implying a boundary that does not exist.
export const NETWORK_POLICY_ENFORCED = false;

// The one phrase every surface uses for that caveat, so the label, /status, the engine's own
// context and the docs cannot drift apart. Flip NETWORK_POLICY_ENFORCED when the proxy lands and
// every caller stops saying it.
export const NETWORK_ADVISORY_NOTE = "advisory — not enforced by the container yet";

export const NETWORK_MODES = Object.freeze({
  OFF: "off",
  ON: "on",
});

export function requestedNetworkPolicy({ allowNetwork = false } = {}) {
  return allowNetwork ? NETWORK_MODES.ON : NETWORK_MODES.OFF;
}

// `supportedModes` is the ADAPTER's declared supports.networkModes — the caller (baseCompile in
// adapters.js, the only call site) passes its own manifest fact, so a third engine's declaration
// is honored without an engine-id branch here and manifest/compiler can never drift.
export function compileNetworkPolicy({ engine, allowNetwork = false, supportedModes = ["off"] } = {}) {
  const mode = requestedNetworkPolicy({ allowNetwork });
  if (mode === NETWORK_MODES.OFF || (supportedModes || []).includes(NETWORK_MODES.ON)) return { mode, supported: true };
  return { mode, supported: false, reason: `${engine || "This engine"} cannot run with the network on` };
}
