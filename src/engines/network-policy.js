import { egressPlanFor } from "../runtimes/container/egress-hook.js";

// Semantic network policy compiled into what each engine is TOLD. Since the container runtime is
// the only runtime, a channel's network is a switch with two states: "on" means the channel is
// meant to use the internet, "off" means it is not. There is no per-domain allow-list any more —
// the host sandbox that compiled one is gone — so an engine either supports "on" or refuses it.
//
// ENFORCED by default. A channel container runs with `--network none` and reaches the internet only
// through the daemon's per-channel egress proxy (src/gateway/egress/), whose policy IS this switch:
// "off" admits only the engine endpoints (and the channel's selected remote MCPs), "on" admits any
// public destination — never a private, loopback or metadata address. The switch is read live on
// every request, so a flip applies to the next connection.
//
// It is still ADVISORY where the proxy is not the container's network: the legacy
// `containerEgressMode = "bridge"` escape, a channel an admin gave raw sockets (`rawNetwork`, the
// open bridge beside the proxy), a daemon whose egress service is down (those runs fail closed
// anyway) and a `/sudo` host thread. Every surface that renders or logs a policy must therefore ask
// networkEnforcedFor(target) for THIS target rather than assume either answer.
export const NETWORK_POLICY_ENFORCED = true;

// The one phrase every surface uses for the advisory case, so the label, /status, the engine's own
// context and the docs cannot drift apart.
export const NETWORK_ADVISORY_NOTE = "advisory — not enforced for this container";

// Is the switch a real boundary for this target? `target` is a RuntimeTarget, or — for a surface
// that only has the channel (a label, the managed CLAUDE.md block) — `{ meta }` (optionally
// `settings`), which is read as the channel's ordinary container.
export function networkEnforcedFor(target = {}) {
  if (!target || target.backend === "host" || target.backend === "local" || target.meta?.sudoMode === true) return false;
  const plan = target.container?.egress || egressPlanFor(target);
  return plan?.active === true && plan.network === "none";
}

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
