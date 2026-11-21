import { BUILTIN_ENGINE_ADAPTERS, licenseAdaptersFor } from "./adapters.js";
import { createAdapterRegistry } from "./contract.js";
import {
  DEFAULT_LICENSE_NAME, LICENSE_POOL_ANY, builtinLicenseName, harnessLabel, harnessOfLicenseId, isHarnessId, isRemovedLicenseId,
  normalizeLicenseRecords, readLicensePool, removedLicenseIds, setLicenseRecords,
} from "./license-state.js";

export const engineRegistry = createAdapterRegistry(BUILTIN_ENGINE_ADAPTERS);
export const ENGINE_IDS = engineRegistry.ids;

export const isEngineId = (value) => Boolean(engineRegistry.get(value));
export const adapterFor = (engine) => engineRegistry.get(engine);
export function requireAdapter(engine) { return engineRegistry.require(engine); }
export function adapterOr(engine, fallbackId = "claude") { return adapterFor(engine) || requireAdapter(fallbackId); }
export function engineSupports(engine, capability) { return Boolean(adapterFor(engine)?.supports?.[capability]); }
export function mintsOwnSessionId(engine) { return Boolean(adapterFor(engine)?.mintsOwnSessionId); }
export function usesMcpConfigFile(engine) { return requireAdapter(engine).mcpTransport === "file"; }
// What an engine id is called on its own. A shipped license an administrator renamed answers to
// that name; a harness's own sign-in stays the harness here (its name is a LICENSE name, below).
export function engineLabel(engine) {
  const adapter = adapterFor(engine);
  if (!adapter) return String(engine || "");
  return (adapter.id !== adapter.cli && engineRegistry.isBuiltin(adapter.id) && builtinLicenseName(adapter.id)) || adapter.label;
}

// ── Harness and license (license-state.js) ────────────────────────────────────────────────────
// Every engine id is a LICENSE of one of the two harnesses; the harness is the CLI that runs it.
// A license-shaped id of a license deleted since still answers, so a stored reference can be
// explained ("a removed Codex license") instead of read as an unknown engine.
export function harnessOf(engine) {
  const cli = adapterFor(engine)?.cli;
  return isHarnessId(cli) ? cli : harnessOfLicenseId(String(engine || ""));
}
export const sameHarness = (a, b) => Boolean(harnessOf(a)) && harnessOf(a) === harnessOf(b);
// The licenses of a harness, built-ins first, in registry order.
export function licensesOfHarness(harness) {
  return ENGINE_IDS.filter((id) => harnessOf(id) === harness);
}
// A stored license pool, read beside the license it belongs to: "any", or the listed licenses that
// still exist and still share that license's harness. Without a license there is no pool. Readers
// and the store use this; a submitted pool is validated strictly (gateway/license-pool.js).
export function coherentLicensePool(pool, engine) {
  const harness = harnessOf(engine);
  const selection = readLicensePool(pool);
  if (!harness || !selection) return "";
  if (selection === LICENSE_POOL_ANY) return LICENSE_POOL_ANY;
  // A license-shaped id still names its harness after the license is deleted, so existence is
  // asked separately — a stored pool echoed back by a settings page must not fail the strict
  // validation for a license nobody can pick any more.
  const rest = selection.filter((id) => id !== engine && isEngineId(id) && harnessOf(id) === harness);
  return rest.length ? rest : "";
}
// What a picker calls this license once the harness is already chosen: the harness's own id is the
// sign-in the gateway always had — "Default sign-in", or the name an administrator gave it.
export function licenseLabel(engine) {
  const adapter = adapterFor(engine);
  if (!adapter) return String(engine || "");
  if (adapter.id === adapter.cli) return builtinLicenseName(adapter.id) || DEFAULT_LICENSE_NAME;
  return (engineRegistry.isBuiltin(adapter.id) && builtinLicenseName(adapter.id)) || adapter.label;
}
// What an engine id reads as on its own where the harness is NOT already shown (a usage card, an
// audit row): the harness for its unnamed own sign-in, "<Harness> · <name>" once that is named or
// for a license an administrator added, and a shipped license's own (possibly renamed) label.
export function engineDisplayName(engine) {
  const adapter = adapterFor(engine);
  if (!adapter) return String(engine || "");
  if (adapter.id === adapter.cli) return builtinLicenseName(adapter.id) ? `${harnessLabel(adapter.cli)} · ${builtinLicenseName(adapter.id)}` : adapter.label;
  if (engineRegistry.isBuiltin(adapter.id)) return engineLabel(adapter.id);
  const harness = harnessOf(adapter.id);
  return harness ? `${harnessLabel(harness)} · ${adapter.label}` : adapter.label;
}
// A harness's own sign-in: the one license of it that can be renamed and never removed.
export const isDefaultLicense = (engine) => isHarnessId(String(engine || "")) && isEngineId(engine);
// A license the gateway ships with that an administrator may remove: every built-in one except a
// harness's own sign-in.
export const isRemovableBuiltinLicense = (engine) => engineRegistry.isBuiltin(String(engine || "")) && !isDefaultLicense(engine);
// Removed by an administrator (license-state.js). The id stays registered — stored sessions, usage
// rows and policies still name it — but it is off everywhere and listed nowhere.
export const isRemovedLicense = (engine) => isRemovableBuiltinLicense(engine) && isRemovedLicenseId(engine);
export const removedBuiltinLicenses = () => removedLicenseIds().filter(isRemovableBuiltinLicense);
// The licenses a surface may LIST: everything registered that has not been removed.
export const listedEngineIds = () => ENGINE_IDS.filter((id) => !isRemovedLicense(id));
// The provider-failure kinds this engine's runner reports as "the provider did not answer" — the
// only kinds the orchestrator replays in place (src/gateway/run.js withTransientRetry). An engine
// that declares none is simply never retried that way.
export function engineTransientKinds(engine) { return adapterFor(engine)?.transientKinds || []; }
// The SETTINGS key holding this engine's configured $/1M token rate, for harnesses that report no
// real dollar cost and can therefore only be estimated. An engine that declares none is recorded
// with tokens and NO cost: inventing one from another provider's rate table would put a number in
// the ledger that no invoice will ever match.
export function engineCostRateKey(engine) { return adapterFor(engine)?.costRateKey || ""; }
// The command a human types to pick this session up by hand. The engine owns the command itself;
// the RUNTIME owns how you reach the engine — a container run has to be entered first, so the
// backend wraps the base command (`<cli> exec -it -w <cwd> <name> <baseCommand>`). Called without
// a target it stays exactly the two-argument host form every existing caller uses.
export function resumeCommandFor(engine, sessionId, { target = null } = {}) {
  const baseCommand = requireAdapter(engine).resumeCommand(sessionId, { target });
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
  // A license's directory is computed per license (no fixed key on the image's path table can
  // name one); every other engine names a key the container backend filled in.
  const inContainer = target?.container
    ? (typeof state.containerDir === "function" ? state.containerDir(target.container) : target.container[state.containerDirKey])
    : "";
  return inContainer ? String(inContainer) : state.hostDir({ channelId: target?.meta?.channelId || "" });
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

/**
 * The session this transcript CONTINUES, read from its first line — a paginated Codex fork names
 * its source rollout there — or `""` for a root session, an engine that declares no such fact, a
 * legacy transcript or anything unparseable. Never throws: a carry must not fail on a header.
 */
export function engineSessionParent(engine, firstLine) {
  const state = engineSessionState(engine);
  if (!state || typeof state.parentSession !== "function") return "";
  try {
    return String(state.parentSession(String(firstLine || "")) || "").trim();
  } catch {
    return "";
  }
}

export function modelBelongsToEngine(model, engine) {
  const value = String(model || "").trim().toLowerCase();
  return !value || Boolean(requireAdapter(engine).modelBelongs(value));
}
// A model id an admin LISTED on a license. A custom server speaks its own vocabulary ("glm-4.6",
// "llama3.1:70b", "accounts/acme/models/large"), which the family-shape gate of the built-in
// harnesses (isValidModel in src/slack/util.js) knows nothing about. The license's own list —
// shape-checked when it was saved (normalizeLicenseModels) — is what admits such a name: with
// `engine`, that license's list; without, any registered license's.
export function isLicenseListedModel(model, engine = "") {
  const value = String(model || "").trim().toLowerCase();
  if (!value) return false;
  return (engine ? [engine] : ENGINE_IDS).some((id) => {
    const adapter = adapterFor(id);
    return Boolean(adapter?.license) && (adapter.models || []).some((entry) => String(entry?.value || "").toLowerCase() === value);
  });
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
    // Drop what is cached for an engine whose adapter was replaced or removed: the next read
    // rebuilds it from the adapter the registry holds now.
    forget(engine) { states.delete(engine); inFlight.delete(engine); },
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
// What the admin UI draws every engine control from. A removed built-in license is not in it, so
// no picker, lock list or settings card can offer it.
export function engineUiManifest() {
  return modelCatalog.manifests().filter((manifest) => !isRemovedLicense(manifest.id)).map((manifest) => ({
    ...manifest,
    harness: harnessOf(manifest.id),
    harnessLabel: harnessLabel(harnessOf(manifest.id)),
    // A renamed shipped license reads under its name everywhere; `shippedLabel` is what it was.
    label: engineLabel(manifest.id),
    shippedLabel: manifest.label,
    licenseLabel: licenseLabel(manifest.id),
    builtin: engineRegistry.isBuiltin(manifest.id),
    // Every shipped license can be renamed (`customName` is "" until it is). The harness's own
    // sign-in is never removed; every other shipped license can be.
    defaultLicense: isDefaultLicense(manifest.id),
    customName: engineRegistry.isBuiltin(manifest.id) ? builtinLicenseName(manifest.id) : "",
    removable: isRemovableBuiltinLicense(manifest.id),
    // What removing it deletes, for the confirmation's wording: "api-key", "sign-in" or "".
    ownCredential: adapterFor(manifest.id)?.ownCredential?.kind || "",
    // True when the listed models are the license's whole catalog (a custom server's own list).
    modelListClosed: adapterFor(manifest.id)?.modelListClosed === true,
  }));
}

// Replace the admin-added licenses with `records` (the stored `engineLicenses` list). Called by
// src/config/settings.js whenever it reads a changed list, in every process that reads settings.
// All-or-nothing: a set the registry refuses leaves the previous licenses in place.
export function syncLicenseAdapters(records) {
  const list = normalizeLicenseRecords(records);
  const dynamicBefore = ENGINE_IDS.filter((id) => !engineRegistry.isBuiltin(id));
  engineRegistry.setDynamic(licenseAdaptersFor(list));
  setLicenseRecords(list);
  // An edited license is a NEW adapter under the same id (its model list may have changed), so
  // every dynamic id's cached catalog goes, not only the removed ones.
  for (const id of new Set([...dynamicBefore, ...list.map((record) => record.id)])) modelCatalog.forget(id);
  return list.map((record) => record.id);
}

// Directed, ordered failover graph. The orchestrator consumes IDs generically; adapters advertise
// no implicit target and an unknown node cannot inherit another engine's route.
// Both edges exist: whichever harness drives a turn, the OTHER one is its failover target — a
// terminal node would mean "primary engine at its usage limit = every turn in that channel fails
// until the quota resets". Ping-pong is impossible because the failover runs the target adapter
// directly (it never re-enters the orchestrator), so a target that also fails just rethrows the
// original error.
const FALLBACK_GRAPH = Object.freeze({ claude: Object.freeze(["codex"]), codex: Object.freeze(["claude"]) });
// A license an administrator ADDED fails over across harnesses the way its harness's own sign-in
// does. The other built-in licenses (dedicated logins, provider endpoints) stay outside the graph.
export function fallbackTargets(engine) {
  const id = String(engine || "");
  const key = FALLBACK_GRAPH[id] ? id : adapterFor(id)?.license ? harnessOf(id) : "";
  return Object.freeze([...(FALLBACK_GRAPH[key] || [])].filter(isEngineId));
}

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
