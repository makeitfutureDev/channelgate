import { BUILTIN_ENGINE_ADAPTERS } from "./adapters.js";
import { createAdapterRegistry } from "./contract.js";

export const engineRegistry = createAdapterRegistry(BUILTIN_ENGINE_ADAPTERS);
export const ENGINE_IDS = engineRegistry.ids;

export const isEngineId = (value) => Boolean(engineRegistry.get(value));
export const adapterFor = (engine) => engineRegistry.get(engine);
export function requireAdapter(engine) { return engineRegistry.require(engine); }
export function adapterOr(engine, fallbackId = "claude") { return adapterFor(engine) || requireAdapter(fallbackId); }
export function engineSupports(engine, capability) { return Boolean(adapterFor(engine)?.supports?.[capability]); }
export function mintsOwnSessionId(engine) { return Boolean(adapterFor(engine)?.mintsOwnSessionId); }
export function usesMcpConfigFile(engine) { return requireAdapter(engine).mcpTransport === "file"; }
export function engineLabel(engine) { return adapterFor(engine)?.label ?? String(engine || ""); }
export function resumeCommandFor(engine, sessionId) { return requireAdapter(engine).resumeCommand(sessionId); }
export function modelBelongsToEngine(model, engine) {
  const value = String(model || "").trim().toLowerCase();
  return !value || Boolean(requireAdapter(engine).modelBelongs(value));
}
export function effortBelongsToEngine(effort, engine) {
  const value = String(effort || "").trim().toLowerCase();
  return !value || requireAdapter(engine).efforts.includes(value);
}
export function engineUiManifest() { return engineRegistry.manifests(); }

// Directed, ordered failover graph. The orchestrator consumes IDs generically; adapters advertise
// no implicit target and an unknown node cannot inherit another engine's route.
// Both edges exist: whichever harness drives a turn, the OTHER one is its failover target — a
// terminal node would mean "primary engine at its usage limit = every turn in that channel fails
// until the quota resets". Ping-pong is impossible because the failover runs the target adapter
// directly (it never re-enters the orchestrator), so a target that also fails just rethrows the
// original error.
const FALLBACK_GRAPH = Object.freeze({ claude: Object.freeze(["codex"]), codex: Object.freeze(["claude"]) });
export function fallbackTargets(engine) { return Object.freeze([...(FALLBACK_GRAPH[String(engine || "")] || [])].filter(isEngineId)); }

// Optional adapter hook. Returns `{ known, authenticated, fingerprint }`; an engine that declares
// no probe answers "could not tell", which every caller must treat as "carry on unchanged".
export async function engineCredentialState(engine) {
  const adapter = adapterFor(engine);
  if (typeof adapter?.credentialState !== "function") return { known: false, authenticated: false, fingerprint: "" };
  const state = await adapter.credentialState();
  return { known: Boolean(state?.known), authenticated: Boolean(state?.authenticated), fingerprint: String(state?.fingerprint || "") };
}

export async function engineHealth(options) {
  return Promise.all(ENGINE_IDS.map(async (id) => ({ id, ...(await requireAdapter(id).health(options)) })));
}
