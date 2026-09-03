// Semantic network policy compiled into what each engine can actually enforce. Since the container
// runtime is the only runtime, a channel's network is a switch: "off" runs the container with no
// network at all, "on" gives it the bridge network. There is no per-domain allow-list any more —
// the host sandbox that compiled one is gone — so an engine either supports "on" or refuses it.
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
