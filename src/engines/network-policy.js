// Semantic network policy compiled into the confinement each engine can actually enforce.
// "approved" means only the administrator's configured domain allowlist; "unrestricted" is
// possible only when the whole engine sandbox is deliberately bypassed for an admin foreground
// turn. An engine must refuse a requested policy it cannot faithfully implement.
import { normalizeNetworkDomains } from "../util/network-domains.js";

export const NETWORK_MODES = Object.freeze({
  OFF: "off",
  APPROVED: "approved",
  UNRESTRICTED: "unrestricted",
});

export function requestedNetworkPolicy({ allowNetwork = false, dangerouslySkip = false } = {}) {
  if (dangerouslySkip) return NETWORK_MODES.UNRESTRICTED;
  return allowNetwork ? NETWORK_MODES.APPROVED : NETWORK_MODES.OFF;
}

// `supportedModes` is the ADAPTER's declared supports.networkModes — the caller (baseCompile in
// adapters.js, the only call site) passes its own manifest fact, so a third engine's declaration
// is honored without an engine-id branch here and manifest/compiler can never drift.
export function compileNetworkPolicy({ engine, allowNetwork = false, dangerouslySkip = false, allowedDomains = [], supportedModes = ["off"] } = {}) {
  const mode = requestedNetworkPolicy({ allowNetwork, dangerouslySkip });
  if (mode === NETWORK_MODES.UNRESTRICTED) return { mode, supported: true };
  if (mode === NETWORK_MODES.OFF) return { mode, supported: true };
  if ((supportedModes || []).includes(NETWORK_MODES.APPROVED)) {
    try {
      return { mode, supported: true, domains: normalizeNetworkDomains(allowedDomains) };
    } catch (error) {
      return { mode, supported: false, reason: `Approved-domain networking has no safe allowlist: ${error.message}` };
    }
  }
  return {
    mode,
    supported: false,
    reason: `${engine || "This engine"} cannot enforce the gateway's approved-domain network allowlist`,
  };
}
