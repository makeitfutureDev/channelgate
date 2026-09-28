// The container backend's view of the daemon's egress service (src/gateway/egress/service.js).
//
// Why a hook and not an import: src/runtimes/ sits below src/gateway/ in the import graph, and the
// egress service reaches into settings, the database and the channel store. The service REGISTERS
// a provider here at boot; the backend only ever asks it questions. With no provider registered
// (a unit test, the host-backend stdio MCP child, a daemon whose boot never reached the service)
// egress is simply not active: the target gets no proxy mounts and no proxy env — and, unless the
// operator chose the legacy `bridge` mode, no network either (`--network none`), so a missing
// service can never silently hand a channel the open bridge.
//
// The PLAN a target carries (`target.container.egress`) is computed once, in prepareTarget, from
// the target's own settings snapshot and meta plus the provider's state — so the mounts, the create
// env, the exec env and the engine env all read one answer:
//   { mode: "proxy"|"bridge", active, network: "none"|"bridge", rawNetwork,
//     socketDir, caBundle, caSpki }
// `active` = the proxy is this target's egress (mode proxy, isolated target, service running).
// `network` = what the container is created with: "bridge" only for the legacy mode or the
// admin-set raw-socket escape (`meta.rawNetwork`); "none" otherwise.

let provider = null;

// { running(): boolean, socketDirFor({slug, platform}): string, caBundlePath(): string,
//   caSpki(): string, ensure(target): Promise<{socketDir, socketPath}>, error(target): string|null,
//   settings?(): object }
export function setEgressProvider(next) {
  provider = next || null;
}

export function egressProvider() {
  return provider;
}

// The operator's choice (Settings → Container runtime → Egress). Anything but "bridge" is the
// proxy: the default, and the fail-closed reading of a malformed value.
export function egressModeOf(settings) {
  return settings?.egressMode === "bridge" ? "bridge" : "proxy";
}

function isolatedTarget(target) {
  if (target?.runtime?.capabilities) return target.runtime.capabilities.isolated === true;
  // A meta-only question (a label, the managed CLAUDE.md block): ordinary turns run in the channel
  // container, so it is the container unless the caller says it is the host.
  return (target?.backend || "container") === "container";
}

function settingsOf(target) {
  if (target?.settings && typeof target.settings === "object") return target.settings;
  try { return provider?.settings?.() || {}; } catch { return {}; }
}

export function egressPlanFor(target = {}) {
  const settings = settingsOf(target);
  const mode = egressModeOf(settings);
  const rawNetwork = target?.meta?.rawNetwork === true;
  const network = mode === "bridge" || rawNetwork ? "bridge" : "none";
  let running = false;
  try { running = Boolean(provider?.running?.()); } catch { running = false; }
  const active = mode === "proxy" && isolatedTarget(target) && running;
  const plan = { mode, active, network, rawNetwork, socketDir: "", caBundle: "", caSpki: "" };
  if (!active) return plan;
  try {
    plan.socketDir = String(provider.socketDirFor({ slug: target.slug, platform: target.platform }) || "");
    plan.caBundle = String(provider.caBundlePath() || "");
    plan.caSpki = String(provider.caSpki?.() || "");
  } catch {
    plan.active = false;
  }
  if (!plan.socketDir || !plan.caBundle) plan.active = false;
  return plan;
}

// Is the proxy this target's egress? Reads the plan the target already carries when it has one.
export function egressActive(target) {
  // No target (an agent job resolves its own per turn) is never an active proxy target.
  if (!target) return false;
  const plan = target?.container?.egress || egressPlanFor(target);
  return plan?.active === true;
}

// Bind the channel's egress listener. Called by ensureUp BEFORE the container is created or
// started, so the socket directory exists as a bind source and a container never comes up pointing
// at a proxy that is not there. A failure throws with the remedy: the run fails closed.
export async function ensureEgressFor(target) {
  // Proxy mode with the service down fails closed for EVERY path that brings a container up (a
  // background job, an SSH session), not only the engine runners' pre-spawn credential gate.
  const down = egressErrorFor(target);
  if (down) throw new Error(down);
  const plan = target?.container?.egress;
  if (!plan?.active) return null;
  if (!provider?.ensure) throw new Error("egress proxy unavailable: the gateway's egress service is not running");
  return provider.ensure(target);
}

// Close the channel's listener when its container is destroyed (an ephemeral update-smoke target,
// a removed channel). Best effort: a listener left behind is harmless and rebinds on demand.
export async function releaseEgressFor(target) {
  try { await provider?.close?.(target); } catch { /* best effort */ }
}

// The pre-spawn remedy string, or null. Proxy mode with the service down (or this channel's
// listener unbindable) must end the run with the reason instead of hanging on a connect.
export function egressErrorFor(target) {
  if (!isolatedTarget(target)) return null;
  if (egressModeOf(settingsOf(target)) !== "proxy") return null;
  if (!provider) return null;
  try {
    const reason = provider.error?.(target);
    return reason ? String(reason) : null;
  } catch (error) {
    return `egress proxy unavailable: ${error?.message || error}`;
  }
}
