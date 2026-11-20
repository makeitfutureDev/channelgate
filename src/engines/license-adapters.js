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
//   • the PROVIDER kinds (`claude-api`, `claude-aws`, `claude-gcp`, `claude-azure`, `codex-api`,
//     `codex-aws`, `codex-gcp`, `codex-azure`) — the provider table, per license: the harness
//     pointed at a server (the vendor's API, any compatible server, Amazon Bedrock, Google Vertex
//     AI, Microsoft Azure) with the license's own credential, which a container holds only as a
//     destination-bound placeholder.
// What every license shares is written once below: opt-in (never enabled implicitly), cold runs
// only (the pool key carries no license), no default-account MCP or model discovery crossing into
// it, and a credential failure that names the license and is replay-safe — which is what lets the
// orchestrator move a turn to the next license of the channel's pool (gateway/license-pool.js).
import { mkdirSync } from "node:fs";
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
  describeLicensePlan, licenseContainerDir, licenseCredentialStored, licenseEndpoint, licenseIsVendorApi, licenseLoginCommand,
  licenseLoginHome, licenseRelaySecretName, licenseTypeLabel, LICENSE_KINDS,
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
    // This license's OWN account: the Subscriptions page reads its directory, not the gateway's.
    subscriptionUsage: { provider: "claude", login: id },
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

// ── Provider licenses: a server + a credential the gateway stores ─────────────────────────────
// One factory per harness serves every provider kind (license-state.js LICENSE_KINDS): the kind's
// facts say which server the record resolves to and how its credential is sent; what differs per
// provider is only how the CLI is TOLD — an environment for Claude Code, `-c` overrides for Codex.

// Opaque and non-reversible; the orchestrator only ever compares it.
function providerFingerprint(record) {
  if (!licenseCredentialStored(record)) return "";
  let h = 0x811c9dc5;
  for (const ch of [record.id, licenseEndpoint(record), record.authScheme, record.apiVersion || "", record.apiKey || record.serviceAccount].join("\u0000")) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${record.id}:${h.toString(16)}`;
}

const FIELD_NAMES = Object.freeze({ baseUrl: "endpoint", region: "region", projectId: "project", apiKey: "API key", serviceAccount: "service-account key" });
// "" when a provider license holds everything its kind runs on, else what is missing.
export function providerLicenseProblem(record) {
  const kind = LICENSE_KINDS[record?.kind];
  if (!kind?.provider) return "this license has no server to check";
  const missing = kind.fields.filter((field) => FIELD_NAMES[field] && !record[field])
    .map((field) => field === "region" && kind.provider === "vertex" ? "location" : FIELD_NAMES[field]);
  if (!missing.length) return "";
  return `no ${missing.length > 1 ? `${missing.slice(0, -1).join(", ")} or ${missing.at(-1)}` : missing[0]} is stored`;
}
export const apiLicenseProblem = providerLicenseProblem;

// What a status line says the license is, without a secret: the provider and where it points.
function providerSummary(record) {
  const kind = LICENSE_KINDS[record.kind];
  if (kind.provider === "bedrock") return `Amazon Bedrock · ${record.region}`;
  if (kind.provider === "vertex") return `Google Vertex AI · ${record.projectId} · ${record.region}`;
  if (kind.provider === "azure") return `Microsoft Azure · ${record.baseUrl}`;
  return `API key · ${record.baseUrl}`;
}

// The readiness every provider license reports the same way. `models` is the adapter's catalog.
function providerStatus(record, models) {
  const kind = LICENSE_KINDS[record.kind];
  const incomplete = providerLicenseProblem(record);
  // A credential the server itself REJECTED the last time it was checked is not offered again
  // until someone corrects it or re-verifies — it would only fail every turn that picked it.
  const rejected = record.verification?.verified && !record.verification.ok;
  const problem = incomplete || (models.length ? "" : "no model is listed for this server")
    || (rejected ? "the server rejected this credential when it was last verified" : "");
  return {
    ready: !problem, signedIn: !incomplete, method: problem ? "" : kind.credential === "service-account" ? "service-account" : "api-key", plan: null,
    detail: problem ? `Not configured — ${problem}.` : providerSummary(record), fingerprint: providerFingerprint(record),
  };
}

// The shared, credential-free half of a provider adapter.
function providerAdapterFacts(record, status, cli) {
  return {
    interrupt: () => false,
    credentialState: async () => {
      const current = status();
      return { known: true, authenticated: current.ready, method: current.method || "none", detail: current.detail, source: licenseEndpoint(record), fingerprint: current.fingerprint };
    },
    licenseStatus: async () => status(),
    selectionReadiness: () => { const current = status(); return { ready: current.ready, reason: current.ready ? "" : current.detail }; },
    async health(options) {
      const base = await commandHealth(cli, options);
      const current = status();
      return { ...base, auth: { known: true, authenticated: current.ready, method: current.method, detail: current.detail } };
    },
    resumeCommand: () => {
      const message = `${record.label} sessions run with a gateway-held credential and cannot be taken over in a terminal; continue this session in chat.`;
      return `sh -c ${shellQuote(`printf '%s\\n' ${shellQuote(message)} >&2; exit 1`)}`;
    },
  };
}

// The credential one run receives: the channel's placeholder in a container, the live value on an
// explicitly resolved direct-host run. A Vertex token for a host run is asked for with most of its
// hour left, because nothing can replace it once the process holds it.
const HOST_TOKEN_MIN_REMAINING_MS = 50 * 60_000;
async function providerRunCredential(record, target, id) {
  const grants = await import("../gateway/egress/grants.js");
  const host = target?.backend === "host";
  let live = { value: "" };
  // A Vertex token is minted before the turn in a container too: a key Google refuses then fails
  // here, replay-safe and with Google's reason, instead of as an unexplained 401 mid-turn.
  if (host || LICENSE_KINDS[record.kind].credential === "service-account") {
    live = await grants.licenseCredentialValue(record, host ? { minRemainingMs: HOST_TOKEN_MIN_REMAINING_MS } : {});
    if (!live.value) throw notReady(id, target, `${record.label} cannot run: ${live.error || "its credential could not be resolved"}.`);
  }
  const credential = grants.containerLicenseApiCredential({ target, record, hostValue: live.value });
  if (!credential.token) throw notReady(id, target, `${record.label} cannot run: ${credential.error}.`);
  // Every real value this run could surface: the stored key, and a token minted for a host run.
  return { token: credential.token, secrets: [record.apiKey, live.value].filter(Boolean) };
}

// ── Claude Code · provider ────────────────────────────────────────────────────────────────────
// What Claude Code 2.1.318 reads for each route (checked against the CLI: the header and path each
// combination produces). The token is the placeholder or the live value — never both.
export function claudeProviderEnv(record, token, configDir) {
  const kind = LICENSE_KINDS[record.kind];
  const bearer = record.authScheme === "bearer";
  const env = { CLAUDE_CONFIG_DIR: configDir };
  if (kind.provider === "bedrock") return { ...env, CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: record.region, AWS_BEARER_TOKEN_BEDROCK: token };
  if (kind.provider === "vertex") {
    return {
      ...env, CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: record.projectId, CLOUD_ML_REGION: record.region,
      // The CLI must not look for Google credentials of its own (there are none in a container and
      // the operator's are not this license's): it sends the token it is handed, to the one host
      // the license resolves to.
      CLAUDE_CODE_SKIP_VERTEX_AUTH: "1", ANTHROPIC_VERTEX_BASE_URL: licenseEndpoint(record), ANTHROPIC_AUTH_TOKEN: token,
    };
  }
  if (kind.provider === "azure") {
    return { ...env, CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_BASE_URL: record.baseUrl, [bearer ? "ANTHROPIC_FOUNDRY_AUTH_TOKEN" : "ANTHROPIC_FOUNDRY_API_KEY"]: token };
  }
  return { ...env, ANTHROPIC_BASE_URL: record.baseUrl, [bearer ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"]: token };
}

const CLOUD_CLAUDE_MODELS = Object.freeze(["opus", "sonnet", "haiku"].map((value) => Object.freeze({
  value, label: value[0].toUpperCase() + value.slice(1), description: `${value[0].toUpperCase() + value.slice(1)}, as Claude Code maps it for this provider.`,
})));

function claudeProviderLicense(claude, record) {
  const id = record.id;
  const kind = LICENSE_KINDS[record.kind];
  const base = claudeBase(claude);
  const vendor = licenseIsVendorApi(record);
  // The models an admin listed are the catalog. With no list, Anthropic's own API offers Claude's
  // catalog and a cloud route offers the three aliases Claude Code resolves itself; any other
  // server offers nothing, and says so when selected.
  const own = record.models.map((model) => ({ label: model.label, value: model.value, description: `${record.label} · ${model.value}` }));
  const models = own.length ? own : vendor ? claude.models : kind.provider !== "custom" ? CLOUD_CLAUDE_MODELS : [];
  const ids = new Set(models.map((model) => model.value.toLowerCase()));
  const status = () => providerStatus(record, models);
  return {
    ...base,
    id, label: record.label, license: licenseFacts(record), optIn: true, modelFamily: `license:${id}`,
    defaultModelKey: licenseDefaultModelKey(id), defaultEffortKey: licenseDefaultEffortKey(id),
    models, modelCatalogSource: "fallback",
    // Claude Code prices a turn from Anthropic's own table, which is this license's bill only when
    // the server IS Anthropic's.
    supports: { ...base.supports, warmPool: false, interruptSteer: false, nativeFork: false, realCost: vendor, ...(kind.provider === "custom" ? {} : { usageLimitFallback: false }) },
    modelBelongs: (model) => own.length || !vendor ? ids.has(String(model || "").toLowerCase()) : claude.modelBelongs(model),
    sessionState: sessionDirs(base, id),
    ...providerAdapterFacts(record, status, "claude"),
    async run(ctx) {
      requirePluginRuntime(ctx.runtime.pluginRuntime, id);
      const { target, configDir } = claudeLicenseTarget(ctx, id);
      const current = status();
      if (!current.ready) throw notReady(id, target, `${record.label} cannot run: ${current.detail}`);
      const credential = await providerRunCredential(record, target, id);
      const result = await runClaudeRedacted({
        ...claudeRunArgs(ctx, target, id, record.label),
        model: ctx.runtime.model || models[0].value,
        providerEnv: claudeProviderEnv(record, credential.token, configDir),
      }, credential.secrets, ctx.runtime);
      return vendor ? result : { ...result, costUSD: null };
    },
  };
}

// ── Codex · provider ──────────────────────────────────────────────────────────────────────────
// The environment variable a Codex provider reads its credential from. Gateway-owned and applied
// after the channel's own secrets, so nothing a channel stores can stand in for it.
const CODEX_KEY_ENV = "CG_LICENSE_KEY";
const toml = (value) => JSON.stringify(String(value));

// What Codex 0.170 is told for each route, as `-c` overrides (checked against the CLI: the header
// and path each produces). Codex speaks the Responses API only — `wire_api="chat"` is refused — so
// a custom server must serve `/responses`.
export function codexProviderRouting(record, token) {
  const kind = LICENSE_KINDS[record.kind];
  if (kind.provider === "bedrock") {
    // Codex's own Bedrock provider; only its region may be set, and the bearer key has one name.
    return {
      config: ['model_provider="amazon-bedrock"', `model_providers.amazon-bedrock.aws.region=${toml(record.region)}`],
      env: { AWS_BEARER_TOKEN_BEDROCK: token, AWS_REGION: record.region }, strip: /^AWS_/,
    };
  }
  if (kind.provider === "vertex") {
    // Codex's own Vertex provider asks a COMMAND for its token; `printenv` hands it the variable.
    return {
      config: [
        'model_provider="gcp"', `model_providers.gcp.project_id=${toml(record.projectId)}`, `model_providers.gcp.location=${toml(record.region)}`,
        `model_providers.gcp.auth={command="printenv",args=[${toml(CODEX_KEY_ENV)}]}`,
      ],
      env: { [CODEX_KEY_ENV]: token }, strip: /^(?:GOOGLE_|GCLOUD_|CLOUDSDK_|CLOUD_ML_)/,
    };
  }
  const name = kind.provider === "azure" ? "cgazure" : "cgapi";
  const config = [
    `model_provider=${toml(name)}`, `model_providers.${name}.name="ChannelGate license"`,
    `model_providers.${name}.base_url=${toml(record.baseUrl)}`, `model_providers.${name}.wire_api="responses"`,
    record.authScheme === "api-key" ? `model_providers.${name}.env_http_headers={"api-key"=${toml(CODEX_KEY_ENV)}}` : `model_providers.${name}.env_key=${toml(CODEX_KEY_ENV)}`,
  ];
  if (record.apiVersion) config.push(`model_providers.${name}.query_params={"api-version"=${toml(record.apiVersion)}}`);
  return { config, env: { [CODEX_KEY_ENV]: token }, strip: null };
}

// Wraps the caller's stream/event sinks so a real credential never reaches a reply.
function redactedRuntime(runtime, secrets) {
  const stream = createSecretRedactor(secrets);
  return {
    stream,
    runtime: {
      ...runtime,
      onDelta: runtime.onDelta ? (chunk) => { const safe = stream.push(chunk); if (safe) runtime.onDelta(safe); } : null,
      onEvent: runtime.onEvent ? (event) => runtime.onEvent(redactSecretFields(event, secrets)) : null,
    },
  };
}

function codexProviderLicense(codex, record) {
  const id = record.id;
  const { updateSmoke: _updateSmoke, discoverModels: _discoverModels, subscriptionUsage: _subscriptionUsage, credentialState: _credentialState, health: _health, ...base } = codex;
  const vendor = licenseIsVendorApi(record);
  const own = record.models.map((model) => ({ label: model.label, value: model.value, description: `${record.label} · ${model.value}` }));
  const models = own.length ? own : vendor ? codex.models : [];
  const ids = new Set(models.map((model) => model.value.toLowerCase()));
  const status = () => providerStatus(record, models);
  return {
    ...base,
    id, label: record.label, license: licenseFacts(record), optIn: true, modelFamily: `license:${id}`,
    defaultModelKey: licenseDefaultModelKey(id), defaultEffortKey: licenseDefaultEffortKey(id),
    models, modelCatalogSource: "fallback",
    // A key no channel carries: the host Codex account's MCP configuration is that account's.
    mcpMetaKey: "allowedCodexLicenseMcps",
    // The gateway estimates a Codex turn from OpenAI's rate table, which is this license's bill
    // only when the server IS OpenAI's: any other server records tokens and no dollar figure.
    costRateKey: vendor ? codex.costRateKey : "",
    supports: { ...base.supports, nativeFork: false },
    modelBelongs: (model) => own.length || !vendor ? ids.has(String(model || "").toLowerCase()) : codex.modelBelongs(model),
    sessionState: sessionDirs(codex, id),
    discoverMcps: async () => [],
    resolveOptionalMcpConfig: async () => ({ servers: {}, rejected: [] }),
    ...providerAdapterFacts(record, status, "codex"),
    async run(ctx) {
      const resolved = runtimeTargetOr(ctx.target, ctx.cwd);
      const isolated = isIsolatedTarget(resolved);
      const current = status();
      if (!current.ready) throw notReady(id, resolved, `${record.label} cannot run: ${current.detail}`);
      const home = isolated ? licenseContainerDir(id, resolved.container?.home) : licenseLoginHome(id);
      const target = {
        ...resolved,
        meta: { ...resolved.meta, engine: id, codexHarness: "" },
        ...(isolated ? { container: { ...resolved.container, codexHome: home } } : {}),
      };
      const credential = await providerRunCredential(record, target, id);
      // Codex refuses a CODEX_HOME that does not exist. The marker names the license and nothing
      // else; the directory then holds this license's session rollouts, apart from every other's.
      try {
        if (isolated) await target.runtime.writeHomeFile(target, { file: `${home}/.cg-license`, body: `${id}\n` });
        else mkdirSync(home, { recursive: true, mode: 0o700 });
      } catch (error) {
        throw notReady(id, target, `${record.label} cannot run: its session directory could not be prepared (${String(error?.message || error).slice(0, 160)}).`);
      }
      const redacted = redactedRuntime(ctx.runtime, credential.secrets);
      try {
        const result = await codex.run.call(this, {
          ...ctx, target,
          runtime: {
            // With no list (OpenAI's own API) an unset model stays unset: the CLI's default.
            ...redacted.runtime, model: ctx.runtime.model || own[0]?.value || "", allowedMcps: [],
            codexStateDir: isolated ? "" : home,
            codexProvider: { ...codexProviderRouting(record, credential.token), home },
          },
        });
        return redactSecretFields(result, credential.secrets);
      } catch (error) {
        if (typeof error.message === "string") error.message = redactSecretValues(error.message, credential.secrets);
        if (typeof error.stack === "string") error.stack = redactSecretValues(error.stack, credential.secrets);
        if (error?.details) error.details = { ...redactSecretFields(error.details, credential.secrets), engine: id };
        throw error;
      } finally {
        const tail = redacted.stream.flush();
        if (tail) ctx.runtime.onDelta?.(tail);
      }
    },
  };
}

const FACTORIES = Object.freeze({
  "codex-login": (bases, record) => codexLoginLicense(bases.codex, record),
  "claude-login": (bases, record) => claudeLoginLicense(bases.claude, record),
});
const factoryFor = (kind) => FACTORIES[kind.id] || (kind.harness === "codex" ? (bases, record) => codexProviderLicense(bases.codex, record) : (bases, record) => claudeProviderLicense(bases.claude, record));

// One unvalidated adapter per record; the registry validates and freezes them as a set.
export function buildLicenseAdapters(bases, records) {
  return (records || []).map((record) => factoryFor(LICENSE_KINDS[record.kind])(bases, record));
}

// ── Verification ──────────────────────────────────────────────────────────────────────────────
// A live check of a provider license against its own server, on demand (never per turn: a probe on
// every turn would bill the operator for asking whether a key works). `fetchImpl` must only reach
// public addresses — the endpoint is admin-supplied and the request carries the credential.
//
// → { ok, verified, detail }. `verified` says whether the server gave a VERDICT on the credential;
// `ok` is false only for a credential that is missing or was refused. A server that offers nothing
// to check a credential against is `ok` and unverified: the first turn is its check, and says so.
function verifyRequest(record, credential) {
  const kind = LICENSE_KINDS[record.kind];
  const endpoint = licenseEndpoint(record);
  const bearer = { authorization: `Bearer ${credential}` };
  if (kind.harness === "claude") {
    // Bedrock lists models on its control plane, not on the runtime host turns use.
    if (kind.provider === "bedrock") return { url: `https://bedrock.${record.region}.amazonaws.com/foundation-models?byProvider=anthropic`, headers: bearer };
    return { url: `${endpoint}/v1/models`, headers: { "anthropic-version": "2023-06-01", ...(record.authScheme === "bearer" ? bearer : { "x-api-key": credential }) } };
  }
  const query = record.apiVersion ? `?api-version=${encodeURIComponent(record.apiVersion)}` : "";
  return { url: `${endpoint}/models${query}`, headers: record.authScheme === "api-key" ? { "api-key": credential } : bearer };
}

export async function verifyProviderLicense(record, { fetchImpl, timeoutMs = 15_000, credentialValue = null } = {}) {
  const problem = providerLicenseProblem(record);
  if (problem) return { ok: false, verified: false, detail: `Not configured — ${problem}.` };
  const kind = LICENSE_KINDS[record.kind];
  // A Vertex license's first proof is Google itself: a service-account key that cannot be
  // exchanged for a token is refused before any model server is asked.
  const resolve = credentialValue || (async () => (await import("../gateway/egress/grants.js")).licenseCredentialValue(record, { vertexFetch: fetchImpl }));
  const live = await resolve(record);
  if (!live?.value) return { ok: false, verified: live?.rejected === true, detail: `${live?.error || "The credential could not be resolved"}.` };
  if (kind.credential === "service-account") {
    // Exchanging the key for a token IS the check Google offers. Whether the project may call the
    // models is a property of the project, shown by the first turn — not asked for here, because
    // Vertex has no listing that answers it without billing a request.
    return { ok: true, verified: true, detail: `Verified: Google accepted the service-account key. Access to the models in project ${record.projectId} is confirmed by the first turn that uses it.` };
  }
  const secrets = [record.apiKey, live.value].filter(Boolean);
  const request = verifyRequest(record, live.value);
  let response;
  try {
    response = await fetchImpl(request.url, { headers: { accept: "application/json", ...request.headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, verified: false, detail: `The server could not be reached: ${redactSecretValues(String(error?.message || error), secrets).slice(0, 200)}` };
  }
  if (response.ok) {
    let count = 0;
    try {
      const body = await response.json();
      const list = [body?.data, body?.modelSummaries, body?.models].find(Array.isArray);
      count = list ? list.length : 0;
    } catch { /* a 200 without a JSON list still proves the credential was accepted */ }
    return { ok: true, verified: true, detail: count ? `Verified: the server accepted this key and lists ${count} model${count === 1 ? "" : "s"}.` : "Verified: the server accepted this key." };
  }
  if (response.status === 401 || response.status === 403) {
    // Bedrock answers 403 both for a bad key and for a good key whose policy does not allow
    // listing models; only its own "not authorized to perform" wording tells them apart.
    if (kind.provider === "bedrock" && response.status === 403) {
      let text = "";
      try { text = String(await response.text()).slice(0, 2000); } catch { text = ""; }
      if (/not authorized to perform|AccessDenied/i.test(text)) {
        return { ok: true, verified: false, detail: "Amazon recognized this key but its policy does not allow listing models, so it is verified by the first turn that uses it." };
      }
    }
    return { ok: false, verified: true, detail: `The server rejected this key (HTTP ${response.status}).` };
  }
  // Compatible servers commonly serve only the generation route; that proves nothing either way.
  return { ok: true, verified: false, detail: `The server has no model list to check the key against (HTTP ${response.status}); it is verified by the first turn that uses it.` };
}
export const verifyApiLicense = verifyProviderLicense;
