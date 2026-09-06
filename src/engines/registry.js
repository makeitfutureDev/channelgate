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
// The provider-failure kinds this engine's runner reports as "the provider did not answer" — the
// only kinds the orchestrator replays in place (src/gateway/run.js withTransientRetry). An engine
// that declares none is simply never retried that way.
export function engineTransientKinds(engine) { return adapterFor(engine)?.transientKinds || []; }
// The command a human types to pick this session up by hand. The engine owns the command itself;
// the RUNTIME owns how you reach the engine — a container run has to be entered first, so the
// backend wraps the base command (`<cli> exec -it -w <cwd> <name> <baseCommand>`). Called without
// a target it stays exactly the two-argument host form every existing caller uses.
export function resumeCommandFor(engine, sessionId, { target = null } = {}) {
  const baseCommand = requireAdapter(engine).resumeCommand(sessionId);
  if (typeof target?.runtime?.resumeCommand !== "function") return baseCommand;
  return target.runtime.resumeCommand(target, { baseCommand });
}
// ── Session state (the `sessionState` fact — see adapters.js) ─────────────────────────────────
// Where a harness keeps a THREAD's own transcript, so the gateway can carry it when a channel
// changes runtime backend. An engine that declares nothing here simply never carries: the existing
// heal (fresh session + the chat transcript replayed) is the safety net, and it still applies.
export function engineSessionState(engine) {
  return adapterFor(engine)?.sessionState || null;
}

// The engine's state dir for a given RuntimeTarget. A container target names it on
// `target.container` (put there by the image's own facts); everything else is the host's. Same
// shape as run-grant-artifacts.js's resolution, and the reason the engine declares a KEY rather
// than importing a container path.
export function engineStateDir(engine, target = null) {
  const state = engineSessionState(engine);
  if (!state) return "";
  const inContainer = target?.container?.[state.containerDirKey];
  return inContainer ? String(inContainer) : state.hostDir();
}

/**
 * The files this session occupies, RELATIVE to that state dir: `[{ rel, kind }]`, where `rel` may
 * contain `*` inside a segment (Codex's rollout filename carries a timestamp nobody can recompute).
 * An engine with no `sessionState`, or a call with no session id, yields nothing.
 */
export function engineSessionFiles(engine, { cwd = "", sessionId = "" } = {}) {
  const state = engineSessionState(engine);
  if (!state || !sessionId) return [];
  const files = state.files({ cwd: String(cwd || ""), sessionId: String(sessionId) }) || [];
  return files
    .filter((entry) => entry && entry.rel)
    .map((entry) => Object.freeze({ rel: String(entry.rel), kind: entry.kind === "dir" ? "dir" : "file" }));
}

export function modelBelongsToEngine(model, engine) {
  const value = String(model || "").trim().toLowerCase();
  return !value || Boolean(requireAdapter(engine).modelBelongs(value));
}
export function effortBelongsToEngine(effort, engine) {
  const value = String(effort || "").trim().toLowerCase();
  return !value || requireAdapter(engine).efforts.includes(value);
}

const DEFAULT_MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cleanText = (value, max) => String(value ?? "").trim().slice(0, max);

function normalizeModels(models, adapter) {
  const seen = new Set();
  return Object.freeze((Array.isArray(models) ? models : []).flatMap((raw) => {
    const value = cleanText(raw?.value, 128);
    if (!value || seen.has(value) || !adapter.modelBelongs(value.toLowerCase())) return [];
    seen.add(value);
    const efforts = [...new Set((Array.isArray(raw?.efforts) ? raw.efforts : [])
      .map((effort) => cleanText(effort, 32).toLowerCase())
      .filter((effort) => adapter.efforts.includes(effort)))];
    return [Object.freeze({
      label: cleanText(raw?.label || value, 80),
      value,
      description: cleanText(raw?.description, 240),
      ...(efforts.length ? { efforts: Object.freeze(efforts) } : {}),
      ...(efforts.includes(cleanText(raw?.defaultEffort, 32).toLowerCase())
        ? { defaultEffort: cleanText(raw.defaultEffort, 32).toLowerCase() }
        : {}),
    })];
  }));
}

export function createEngineModelCatalog(registry, {
  ttlMs = DEFAULT_MODEL_CACHE_TTL_MS,
  now = () => Date.now(),
  log = (message) => console.warn(message),
} = {}) {
  const states = new Map();
  const inFlight = new Map();

  const stateFor = (engine) => {
    const adapter = registry.require(engine);
    if (!states.has(engine)) {
      states.set(engine, {
        models: normalizeModels(adapter.models, adapter),
        source: adapter.modelCatalogSource === "aliases" ? "aliases" : "fallback",
        refreshedAt: "",
        attemptedAt: null,
        error: "",
      });
    }
    return states.get(engine);
  };

  const snapshot = (engine) => {
    const state = stateFor(engine);
    return Object.freeze({
      models: state.models,
      source: state.source,
      refreshedAt: state.refreshedAt,
      error: state.error,
    });
  };

  const refreshOne = async (engine, { force = false } = {}) => {
    const adapter = registry.require(engine);
    const state = stateFor(engine);
    if (typeof adapter.discoverModels !== "function") return snapshot(engine);
    const at = now();
    if (inFlight.has(engine)) return inFlight.get(engine);
    if (!force && state.attemptedAt !== null && at - state.attemptedAt < ttlMs) return snapshot(engine);
    state.attemptedAt = at;
    const pending = Promise.resolve()
      .then(() => adapter.discoverModels())
      .then((models) => {
        const normalized = normalizeModels(models, adapter);
        if (!normalized.length) throw new Error("model discovery returned no usable models");
        state.models = normalized;
        state.source = "live";
        state.refreshedAt = new Date(now()).toISOString();
        state.error = "";
        return snapshot(engine);
      })
      .catch((error) => {
        if (state.source === "live" || state.source === "cached") state.source = "cached";
        state.error = cleanText(error?.message || error, 300);
        log(`[models] ${engine} discovery failed; using ${state.source} catalog: ${state.error}`);
        return snapshot(engine);
      })
      .finally(() => inFlight.delete(engine));
    inFlight.set(engine, pending);
    return pending;
  };

  return Object.freeze({
    snapshot,
    refresh(engine = "", options = {}) {
      if (engine) return refreshOne(engine, options);
      return Promise.all(registry.ids.map((id) => refreshOne(id, options)));
    },
    manifests() {
      return registry.manifests().map((manifest) => {
        const current = snapshot(manifest.id);
        return {
          ...manifest,
          models: structuredClone(current.models),
          modelCatalog: { source: current.source, refreshedAt: current.refreshedAt },
        };
      });
    },
    effortsFor(engine, model = "") {
      const current = snapshot(engine);
      const selected = current.models.find((entry) => entry.value === String(model || "").trim());
      return Object.freeze([...(selected?.efforts?.length ? selected.efforts : registry.require(engine).efforts)]);
    },
  });
}

const modelCatalog = createEngineModelCatalog(engineRegistry);

export function refreshEngineModels(engine = "", options = {}) { return modelCatalog.refresh(engine, options); }
export function modelsForEngine(engine) { return modelCatalog.snapshot(engine).models; }
export function effortsForModel(engine, model = "") { return modelCatalog.effortsFor(engine, model); }
export function effortBelongsToModel(effort, engine, model = "") {
  const value = String(effort || "").trim().toLowerCase();
  return !value || effortsForModel(engine, model).includes(value);
}
export function engineUiManifest() { return modelCatalog.manifests(); }

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
