// The engine adapter behind each license an administrator added (license-state.js explains the
// model: two harnesses, any number of licenses per harness).
//
// Nothing here is a new way to run a turn. Each kind is the generalization of a harness the
// gateway already shipped as a one-off, built from the SAME base adapter and the same guarantees:
//   • `codex-login`  — Codex EU, per license: an isolated ChatGPT sign-in in its own CODEX_HOME,
//     relayed into a container as an access-only auth.json holding that license's placeholder.
//   • `claude-login` — the extra Claude subscription, per license: an isolated Claude sign-in in
//     its own config dir, relayed as that license's placeholder. Subscription only; the AWS wizard
//     stays on the built-in Claude Extra harness.
//   • `claude-api`   — the provider table, per license: Claude Code pointed at an
//     Anthropic-compatible endpoint with the license's own key, which a container holds only as a
//     destination-bound placeholder.
// What every license shares is written once below: opt-in (never enabled implicitly), cold runs
// only (the pool key carries no license), no default-account MCP or model discovery crossing into
// it, and a credential failure that names the license and is replay-safe — which is what lets the
// orchestrator move a turn to the next license of the channel's pool (gateway/license-pool.js).
import { commandHealth } from "./contract.js";
import { runClaude } from "./claude.js";
import { isIsolatedTarget, runtimeTargetOr } from "./runtime-target.js";
import { discoverCodexModels } from "./model-discovery.js";
import { dedicatedCodexCredentialState } from "./codex-eu.js";
import { extraClaudeCredentialState, resolveExtraClaudeProvider, resolveExtraClaudeToken } from "./bedrock.js";
import { codexAuthProcessEnv, codexHarnessFor } from "../gateway/channel-codex-paths.js";
import { requirePluginRuntime } from "../gateway/plugin-runtime.js";
import { createSecretRedactor, redactSecretFields, redactSecretValues } from "../util/redact.js";
import {
  describeLicensePlan, licenseApiHost, licenseContainerDir, licenseLoginCommand, licenseLoginHome,
  licenseRelaySecretName, licenseTypeLabel, LICENSE_KINDS,
} from "./license-state.js";

// Per-license gateway defaults live under their own settings keys, so the generic "default model /
// effort per engine" plumbing (config/settings.js) serves a license without knowing it is one.
export const licenseDefaultModelKey = (id) => `licenseDefaultModel:${id}`;
export const licenseDefaultEffortKey = (id) => `licenseDefaultEffort:${id}`;

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const notReady = (id, target, message) => Object.assign(new Error(message), {
  // The same shape a missing provider key has always thrown: nothing has run, so the turn may be
  // replayed on another license.
  details: { runtimeCredential: true, runtime: target?.backend, engine: id, providerKind: "authentication", providerError: true, replaySafe: true, toolUseCount: 0 },
});

// The facts every surface shows about a license. Plain data: it rides the UI manifest.
const licenseFacts = (record) => Object.freeze({
  kind: record.kind, kindLabel: LICENSE_KINDS[record.kind].label, type: record.type, typeLabel: licenseTypeLabel(record.type),
});

const sessionDirs = (base, id) => Object.freeze({
  ...base.sessionState,
  // Another license's transcripts are not this one's history.
  channelHistory: false,
  hostDir: () => licenseLoginHome(id),
  // No fixed key on the image's path table can name a directory per license; `containerDir`
  // computes it from the target's container facts (registry.js engineStateDir, the container
  // backend). The key stays declared, and unset, to satisfy the contract.
  containerDirKey: "licenseStateDir",
  containerDir: (container) => licenseContainerDir(id, container?.home),
});

// ── Codex · ChatGPT sign-in ───────────────────────────────────────────────────────────────────
function codexLoginLicense(codex, record) {
  const id = record.id;
  const state = (options = {}) => dedicatedCodexCredentialState({ home: licenseLoginHome(id), label: record.label, loginHint: licenseLoginCommand(record), ...options });
  const status = async (options) => {
    const auth = await state(options);
    const plan = auth.authenticated ? describeLicensePlan({ harness: "codex", declared: record.type, plan: auth.planType }) : null;
    const ready = auth.authenticated === true && plan?.matches !== false;
    return { ready, signedIn: auth.authenticated === true, method: auth.method || "", plan, detail: ready ? plan.detail : auth.authenticated ? plan.detail : `Not signed in — ${auth.detail}.`, fingerprint: auth.fingerprint || "" };
  };
  return {
    ...codex,
    subscriptionUsage: { provider: "codex", login: id },
    id, label: record.label, license: licenseFacts(record), optIn: true, modelFamily: "codex",
    defaultModelKey: licenseDefaultModelKey(id), defaultEffortKey: licenseDefaultEffortKey(id),
    // Deliberately a key no channel carries: the host Codex account's MCP configuration belongs to
    // that account and must not cross into an isolated sign-in.
    mcpMetaKey: "allowedCodexLicenseMcps",
    supports: { ...codex.supports },
    resumeCommand(sessionId, { target = null } = {}) {
      const home = isIsolatedTarget(target) ? licenseContainerDir(id, target?.container?.home) : licenseLoginHome(id);
      return `env CODEX_HOME=${shellQuote(home)} codex exec resume ${shellQuote(sessionId)}`;
    },
    sessionState: sessionDirs(codex, id),
    discoverMcps: async () => [],
    resolveOptionalMcpConfig: async () => ({ servers: {}, rejected: [] }),
    async discoverModels() {
      const auth = await state();
      if (!auth.authenticated) throw new Error(auth.detail);
      return discoverCodexModels({ env: codexAuthProcessEnv(licenseLoginHome(id)) });
    },
    credentialState: () => state(),
    licenseStatus: status,
    async selectionReadiness() {
      const current = await status();
      return { ready: current.ready, reason: current.ready ? "" : current.detail };
    },
    async health(options) {
      const cli = await commandHealth("codex", options);
      const current = await status();
      return { ...cli, auth: { known: true, authenticated: current.ready, method: current.method, detail: current.detail } };
    },
    async run(ctx) {
      const current = await status();
      if (!current.ready) throw notReady(id, ctx.target, `${record.label} cannot run: ${current.detail}`);
      const target = ctx.target;
      const own = {
        ...target,
        meta: { ...target?.meta, engine: id, codexHarness: codexHarnessFor(id) },
        ...(target?.container ? { container: { ...target.container, codexHome: licenseContainerDir(id, target.container.home) } } : {}),
      };
      try {
        return await codex.run.call(this, { ...ctx, target: own, runtime: { ...ctx.runtime, allowedMcps: [], codexStateDir: isIsolatedTarget(target) ? "" : licenseLoginHome(id) } });
      } catch (error) {
        if (error?.details) error.details = { ...error.details, engine: id };
        throw error;
      }
    },
    updateSmoke: undefined,
  };
}

// Runs Claude Code with every stream, event, result and error passed through a redactor that
// knows this license's real credential — the value a container never holds, kept out of the reply
// anyway (a host run does hold it).
async function runClaudeRedacted(args, secrets, runtime) {
  const stream = createSecretRedactor(secrets);
  try {
    const result = await runClaude({
      ...args,
      onDelta: runtime.onDelta ? (chunk) => { const safe = stream.push(chunk); if (safe) runtime.onDelta(safe); } : null,
      onEvent: runtime.onEvent ? (event) => runtime.onEvent(redactSecretFields(event, secrets)) : null,
    });
    return redactSecretFields(result, secrets);
  } catch (error) {
    if (typeof error.message === "string") error.message = redactSecretValues(error.message, secrets);
    if (typeof error.stack === "string") error.stack = redactSecretValues(error.stack, secrets);
    if (error.details) error.details = redactSecretFields(error.details, secrets);
    throw error;
  } finally {
    const tail = stream.flush();
    if (tail) runtime.onDelta?.(tail);
  }
}

const claudeRunArgs = (ctx, target, id, label) => {
  const r = ctx.runtime;
  return {
    cwd: ctx.cwd, prompt: ctx.prompt, sessionId: ctx.session.id, isNewSession: ctx.session.fresh,
    forkSourceSessionId: r.forkSourceSessionId, mcpConfig: r.mcpConfigFile, strictMcp: r.strictMcp,
    dangerouslySkip: r.dangerouslySkip, settingsFile: r.settingsFile, model: r.model, effort: r.effort,
    timeoutMs: r.timeoutMs, maxSilenceMs: r.maxSilenceMs, signal: r.signal, onSessionResolved: r.onSessionResolved,
    permissionPromptTool: r.permissionPromptTool, pluginDirs: r.claudePluginDirs, instructionFile: r.instructionFile,
    disallowedTools: r.disallowedTools, extraEnv: r.channelEnv, browserNamespace: r.browserNamespace, target,
    engineId: id, harnessLabel: label,
    // No login of the gateway's own reaches this child: buildClaudeEnv strips the family before the
    // license's provider environment is applied.
    claudeOauthToken: "",
  };
};

// The target a Claude license runs on: its own transcript directory, never the shared one, without
// mutating the target other engines of the same turn receive.
function claudeLicenseTarget(ctx, id) {
  const resolved = runtimeTargetOr(ctx.target, ctx.cwd);
  const isolated = isIsolatedTarget(resolved);
  const configDir = isolated ? licenseContainerDir(id, resolved.container?.home) : licenseLoginHome(id);
  return {
    configDir,
    target: {
      ...resolved,
      meta: { ...resolved.meta, engine: id, codexHarness: "" },
      ...(isolated ? { container: { ...resolved.container, claudeConfigDir: configDir } } : {}),
    },
  };
}

// The optional operations of the built-in Claude adapter that resolve the gateway's OWN Anthropic
// login; a license must inherit none of them.
function claudeBase(claude) {
  const { updateSmoke: _updateSmoke, discoverModels: _discoverModels, subscriptionUsage: _subscriptionUsage, credentialState: _credentialState, health: _health, ...base } = claude;
  return base;
}

// ── Claude Code · Claude sign-in ──────────────────────────────────────────────────────────────
function claudeLoginLicense(claude, record) {
  const id = record.id;
  const base = claudeBase(claude);
  const configDir = () => licenseLoginHome(id);
  const remedy = () => `run \`${licenseLoginCommand(record)}\` on the gateway host and sign in with the intended Claude account`;
  const status = () => {
    const provider = resolveExtraClaudeProvider({ configDir: configDir() });
    // The directory is a license's, and a license of this kind is a Claude sign-in: an AWS setup
    // in it is not this license (Bedrock stays on the built-in Claude Extra harness).
    if (provider.kind !== "subscription" || !provider.configured) {
      const why = provider.kind === "bedrock" ? "this license's directory holds an Amazon Bedrock setup, which a Claude sign-in license does not run" : "";
      return { ready: false, signedIn: false, method: "", plan: null, detail: `Not signed in — ${why || remedy()}.`, fingerprint: "" };
    }
    const plan = describeLicensePlan({ harness: "claude", declared: record.type, plan: provider.login.plan });
    return { ready: plan.matches !== false, signedIn: true, method: "claude-subscription", plan, detail: plan.detail, fingerprint: provider.login.fingerprint || "" };
  };
  return {
    ...base,
    id, label: record.label, license: licenseFacts(record), optIn: true,
    defaultModelKey: licenseDefaultModelKey(id), defaultEffortKey: licenseDefaultEffortKey(id),
    supports: { ...base.supports, warmPool: false, interruptSteer: false },
    sessionState: sessionDirs(base, id),
    resumeCommand(sessionId, { target } = {}) {
      // A bare terminal exec in the container holds no live lease, so the proxy would refuse this
      // license's relay; say so rather than resume on a different account.
      if (isIsolatedTarget(target)) {
        const message = `${record.label} sessions cannot be taken over in a container terminal; continue this session in chat.`;
        return `sh -c ${shellQuote(`printf '%s\\n' ${shellQuote(message)} >&2; exit 1`)}`;
      }
      return `env CLAUDE_CONFIG_DIR=${shellQuote(configDir())} claude --resume ${shellQuote(sessionId)}`;
    },
    async run(ctx) {
      requirePluginRuntime(ctx.runtime.pluginRuntime, id);
      const { target, configDir: runDir } = claudeLicenseTarget(ctx, id);
      const current = status();
      if (!current.ready) throw notReady(id, target, `${record.label} cannot run: ${current.detail}`);
      const { containerExtraClaudeCredential } = await import("../gateway/egress/grants.js");
      const relay = await resolveExtraClaudeToken({ configDir: configDir() });
      const credential = containerExtraClaudeCredential({ target, relay, secretName: licenseRelaySecretName(id), label: record.label });
      if (!credential.token) throw notReady(id, target, `${record.label} cannot run: ${credential.error || "its Claude sign-in is unavailable"}.`);
      return runClaudeRedacted({
        ...claudeRunArgs(ctx, target, id, record.label),
        providerEnv: { CLAUDE_CODE_OAUTH_TOKEN: credential.token, CLAUDE_CONFIG_DIR: runDir },
      }, [relay.token], ctx.runtime);
    },
    interrupt: () => false,
    credentialState: () => {
      const auth = extraClaudeCredentialState({ configDir: configDir() });
      return auth.method === "claude-subscription" ? auth : { ...auth, authenticated: false, method: "none" };
    },
    licenseStatus: async () => status(),
    selectionReadiness: () => { const current = status(); return { ready: current.ready, reason: current.ready ? "" : current.detail }; },
    async health(options) {
      const cli = await commandHealth("claude", options);
      const current = status();
      return { ...cli, auth: { known: true, authenticated: current.ready, method: current.method, detail: current.detail } };
    },
  };
}

// ── Claude Code · API key ─────────────────────────────────────────────────────────────────────
const ANTHROPIC_API_HOST = "api.anthropic.com";

// Opaque and non-reversible; the orchestrator only ever compares it.
function apiFingerprint(record) {
  if (!record.apiKey) return "";
  let h = 0x811c9dc5;
  for (const ch of `${record.id}\u0000${record.baseUrl}\u0000${record.authScheme}\u0000${record.apiKey}`) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${record.id}:${h.toString(16)}`;
}

export function apiLicenseProblem(record) {
  if (!record.baseUrl && !record.apiKey) return "no endpoint or API key is stored";
  if (!record.baseUrl) return "no endpoint is stored";
  if (!record.apiKey) return "no API key is stored";
  return "";
}

function claudeApiLicense(claude, record) {
  const id = record.id;
  const base = claudeBase(claude);
  const anthropic = licenseApiHost(record) === ANTHROPIC_API_HOST;
  // The models an admin listed are the catalog. An Anthropic-API license with no list offers
  // Claude's own; any other endpoint with no list offers nothing, and says so when selected.
  const own = record.models.map((model) => ({ label: model.label, value: model.value, description: `${record.label} · ${model.value}` }));
  const models = own.length ? own : anthropic ? claude.models : [];
  const ownIds = new Set(own.map((model) => model.value.toLowerCase()));
  const status = () => {
    const problem = apiLicenseProblem(record) || (models.length ? "" : "no model is listed for this endpoint");
    return {
      ready: !problem, signedIn: !apiLicenseProblem(record), method: problem ? "" : "api-key", plan: null,
      detail: problem ? `Not configured — ${problem}.` : `API key · ${record.baseUrl}`, fingerprint: apiFingerprint(record),
    };
  };
  return {
    ...base,
    id, label: record.label, license: licenseFacts(record), optIn: true, modelFamily: `license:${id}`,
    defaultModelKey: licenseDefaultModelKey(id), defaultEffortKey: licenseDefaultEffortKey(id),
    models, modelCatalogSource: "fallback",
    // Claude Code prices a turn from Anthropic's own table, which is this license's bill only when
    // the endpoint IS Anthropic's.
    supports: { ...base.supports, warmPool: false, interruptSteer: false, nativeFork: false, realCost: anthropic },
    modelBelongs: (model) => own.length ? ownIds.has(String(model || "").toLowerCase()) : anthropic && claude.modelBelongs(model),
    sessionState: sessionDirs(base, id),
    resumeCommand: () => {
      const message = `${record.label} sessions run with a gateway-held API key and cannot be taken over in a terminal; continue this session in chat.`;
      return `sh -c ${shellQuote(`printf '%s\\n' ${shellQuote(message)} >&2; exit 1`)}`;
    },
    async run(ctx) {
      requirePluginRuntime(ctx.runtime.pluginRuntime, id);
      const { target, configDir } = claudeLicenseTarget(ctx, id);
      const current = status();
      if (!current.ready) throw notReady(id, target, `${record.label} cannot run: ${current.detail}`);
      const { containerLicenseApiCredential } = await import("../gateway/egress/grants.js");
      const credential = containerLicenseApiCredential({ target, record });
      if (!credential.token) throw notReady(id, target, `${record.label} cannot run: ${credential.error}.`);
      const result = await runClaudeRedacted({
        ...claudeRunArgs(ctx, target, id, record.label),
        model: ctx.runtime.model || models[0].value,
        providerEnv: {
          ANTHROPIC_BASE_URL: record.baseUrl,
          [record.authScheme === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"]: credential.token,
          CLAUDE_CONFIG_DIR: configDir,
        },
      }, [record.apiKey], ctx.runtime);
      return anthropic ? result : { ...result, costUSD: null };
    },
    interrupt: () => false,
    credentialState: async () => {
      const current = status();
      return { known: true, authenticated: current.ready, method: current.method || "none", detail: current.detail, source: record.baseUrl, fingerprint: current.fingerprint };
    },
    licenseStatus: async () => status(),
    selectionReadiness: () => { const current = status(); return { ready: current.ready, reason: current.ready ? "" : current.detail }; },
    async health(options) {
      const cli = await commandHealth("claude", options);
      const current = status();
      return { ...cli, auth: { known: true, authenticated: current.ready, method: current.method, detail: current.detail } };
    },
  };
}

const FACTORIES = Object.freeze({ "codex-login": (bases, record) => codexLoginLicense(bases.codex, record), "claude-login": (bases, record) => claudeLoginLicense(bases.claude, record), "claude-api": (bases, record) => claudeApiLicense(bases.claude, record) });

// One unvalidated adapter per record; the registry validates and freezes them as a set.
export function buildLicenseAdapters(bases, records) {
  return (records || []).map((record) => FACTORIES[record.kind](bases, record));
}

// A live check of an API license against its own endpoint, on demand (never per turn: a probe on
// every turn would bill the operator for asking whether a key works). `fetchImpl` must only reach
// public addresses — the endpoint is admin-supplied and the request carries the key.
export async function verifyApiLicense(record, { fetchImpl, timeoutMs = 15_000 } = {}) {
  const problem = apiLicenseProblem(record);
  if (problem) return { ok: false, verified: false, detail: `Not configured — ${problem}.` };
  const headers = { accept: "application/json", "anthropic-version": "2023-06-01", ...(record.authScheme === "bearer" ? { authorization: `Bearer ${record.apiKey}` } : { "x-api-key": record.apiKey }) };
  let response;
  try {
    response = await fetchImpl(`${record.baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, verified: false, detail: `The endpoint could not be reached: ${redactSecretValues(String(error?.message || error), [record.apiKey]).slice(0, 200)}` };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, verified: true, detail: `The endpoint rejected this key (HTTP ${response.status}).` };
  if (response.ok) {
    let count = 0;
    try { const body = await response.json(); count = Array.isArray(body?.data) ? body.data.length : 0; } catch { /* a 200 without a JSON list still proves the key was accepted */ }
    return { ok: true, verified: true, detail: count ? `Verified: the endpoint accepted this key and lists ${count} model${count === 1 ? "" : "s"}.` : "Verified: the endpoint accepted this key." };
  }
  // Anthropic-compatible providers commonly serve /v1/messages only; that proves nothing either way.
  return { ok: true, verified: false, detail: `The endpoint has no model list to check the key against (HTTP ${response.status}); it is verified by the first turn that uses it.` };
}
