// Amazon Bedrock is a distinct Claude Code harness with its own terminal setup and sessions.
// Read ONLY reviewed provider environment values from the terminal wizard's settings.json. Its
// permissions, hooks, credential commands and MCP definitions never enter a gateway run: the
// runner continues to use --setting-sources "" and the gateway's explicit lockdown file.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { gatewayRoot } from "../config/paths.js";
import { commandHealth, validateEngineAdapter } from "./contract.js";
import { runClaude } from "./claude.js";
import { compileNetworkPolicy } from "./network-policy.js";
import { containerPaths, isIsolatedTarget, runtimeTargetOr } from "./runtime-target.js";
import { requirePluginRuntime } from "../gateway/plugin-runtime.js";
import { createSecretRedactor, redactSecretFields, redactSecretValues } from "../util/redact.js";

export const BEDROCK_ENGINE_ID = "claude-bedrock";
const NETWORK_MODES = Object.freeze(["off", "on"]);
const MAX_SETTINGS_BYTES = 1024 * 1024;
const REGION_RE = /^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:[a-z]+-)*[a-z]+-\d+$/;
const MODEL_NAMES = Object.freeze([
  "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
]);
export const BEDROCK_PROVIDER_ENV_NAMES = Object.freeze([
  "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_BEARER_TOKEN_BEDROCK", "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_BEDROCK_REGION_PREFIX", ...MODEL_NAMES,
]);

export function bedrockLoginHome() {
  return path.join(gatewayRoot(), "engine-state", BEDROCK_ENGINE_ID);
}

function bedrockRuntimeConfigDir(target) {
  return isIsolatedTarget(target)
    ? target.container?.claudeBedrockConfigDir || `${containerPaths(target).home}/.claude-bedrock`
    : bedrockLoginHome();
}

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

export function isBedrockModel(value) {
  const model = String(value || "").trim();
  return /^(?:opus|sonnet|haiku)(?:\[1m\])?$/.test(model)
    || /^(?:(?:us|eu|apac|global|us-gov)\.)?anthropic\.claude-[a-z0-9][a-z0-9.:_-]*(?:\[1m\])?$/.test(model)
    || /^arn:aws(?:-us-gov)?:bedrock:[a-z0-9-]+:\d{12}:(?:application-)?inference-profile\/[A-Za-z0-9._:-]+$/.test(model);
}

function readProviderSettings(configDir) {
  let fd;
  try {
    fd = openSync(path.join(configDir, "settings.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return { error: "Bedrock terminal settings must be a regular JSON file smaller than 1 MiB" };
    const settings = JSON.parse(readFileSync(fd, "utf8"));
    return { settings };
  } catch (error) {
    return { error: error.code === "ENOENT"
      ? "no Bedrock terminal setup was found; run the isolated Claude command in Settings, then /setup-bedrock and choose Amazon Bedrock API key"
      : "Bedrock terminal settings could not be read as JSON; rerun /setup-bedrock in its isolated Claude directory", missing: error.code === "ENOENT" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Synchronous so the egress policy can derive the exact current regional endpoint without a
// cached wildcard grant. Deliberately never falls back to the daemon's AWS/Anthropic environment.
export function resolveBedrockProvider({ configDir = bedrockLoginHome() } = {}) {
  const base = { id: BEDROCK_ENGINE_ID, label: "Claude Bedrock", configDir, configured: false, bearerToken: "", region: "", endpoint: "", env: {} };
  const loaded = readProviderSettings(configDir);
  if (loaded.error) return { ...base, error: loaded.error };
  const settings = loaded.settings;
  const source = settings?.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? settings.env : {};
  const read = (name) => typeof source[name] === "string" ? source[name].trim() : "";
  const region = read("AWS_REGION") || read("AWS_DEFAULT_REGION");
  if (!REGION_RE.test(region)) return { ...base, error: "a valid AWS_REGION is required in the Bedrock terminal setup" };
  // SigV4 signs requests with the secret itself: substituting a placeholder after signing cannot
  // work. Keep AWS profiles, SSO caches and long-lived AWS keys out of the shared channel HOME.
  const bearerToken = read("AWS_BEARER_TOKEN_BEDROCK");
  if (!bearerToken) return { ...base, region, error: "this harness requires an Amazon Bedrock API key; AWS profiles, SSO and SigV4 access keys are not supported here. Rerun /setup-bedrock and choose Amazon Bedrock API key" };
  if (/\s/.test(bearerToken)) return { ...base, region, error: "the Bedrock API key contains invalid whitespace; rerun /setup-bedrock" };
  if (read("ANTHROPIC_BEDROCK_BASE_URL") || read("AWS_ENDPOINT_URL") || read("AWS_ENDPOINT_URL_BEDROCK_RUNTIME")) {
    return { ...base, region, error: "custom Bedrock endpoints are not supported; use the standard regional AWS endpoint" };
  }
  const secondaryRegion = read("ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION");
  if (secondaryRegion && secondaryRegion !== region) return { ...base, region, error: "the Bedrock small/fast model must use the configured AWS_REGION" };
  const env = { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: region };
  for (const name of MODEL_NAMES) {
    const value = read(name);
    if (!value) continue;
    if (!isBedrockModel(value)) return { ...base, region, error: `the Bedrock terminal setup has an invalid ${name} model pin` };
    env[name] = value;
  }
  const prefix = read("ANTHROPIC_BEDROCK_REGION_PREFIX");
  if (prefix && !/^(?:us|eu|apac|global|us-gov)$/.test(prefix)) return { ...base, region, error: "the Bedrock terminal setup has an invalid region prefix" };
  if (prefix) env.ANTHROPIC_BEDROCK_REGION_PREFIX = prefix;
  return { ...base, region, bearerToken, endpoint: `https://bedrock-runtime.${region}.amazonaws.com`, env, configured: true, error: "" };
}

export function bedrockCredentialState(options) {
  const provider = resolveBedrockProvider(options);
  return {
    known: true, authenticated: provider.configured,
    method: provider.configured ? "bedrock-api-key" : "none",
    detail: provider.configured ? `Amazon Bedrock API key · ${provider.region}` : provider.error,
    source: provider.configDir,
    fingerprint: provider.configured ? `bedrock:${createHash("sha256").update(`${provider.region}\0${provider.bearerToken}`).digest("hex")}` : "",
  };
}

// This additional Claude Code process owns one login directory, regardless of whether the
// operator chose Claude subscription sign-in or the AWS wizard. A partial AWS setup must never
// fall through to a subscription, and neither mode may borrow the default Claude account.
export function resolveExtraClaudeProvider({ configDir = bedrockLoginHome(), now = Date.now } = {}) {
  const loaded = readProviderSettings(configDir);
  if (loaded.error && !loaded.missing) return { kind: "none", configured: false, error: loaded.error };
  const settings = loaded.missing ? {} : loaded.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)
      || (settings.env !== undefined && (!settings.env || typeof settings.env !== "object" || Array.isArray(settings.env)))) {
    return { kind: "none", configured: false, error: "the extra Claude terminal settings must contain a JSON object" };
  }
  const env = settings.env || {};
  const populated = Object.entries(env).filter(([, value]) => value !== "" && value !== null && value !== undefined);
  if (populated.some(([name]) => /^(?:AWS_|ANTHROPIC_BEDROCK_|CLAUDE_CODE_USE_BEDROCK$)/.test(name))) {
    return { kind: "bedrock", ...resolveBedrockProvider({ configDir }) };
  }
  if (populated.some(([name]) => /^(?:CLAUDE_CODE_USE_|ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL)$)/.test(name))) {
    return { kind: "none", configured: false, error: "this extra Claude login supports a Claude subscription or /setup-bedrock; remove conflicting provider routing from its terminal settings" };
  }
  const login = extraClaudeLogin({ configDir, now });
  return { kind: "subscription", configured: login.kind !== "none", configDir, login, error: login.reason || "" };
}

function readExtraClaudeCredentials(configDir) {
  let fd;
  try {
    fd = openSync(path.join(configDir, ".credentials.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return null;
    return JSON.parse(readFileSync(fd, "utf8"))?.claudeAiOauth || null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function extraClaudeLogin({ configDir, now }) {
  const oauth = readExtraClaudeCredentials(configDir);
  const usable = typeof oauth?.accessToken === "string" && oauth.accessToken.trim()
    && !(Number(oauth.refreshTokenExpiresAt) && Number(oauth.refreshTokenExpiresAt) <= now());
  if (!usable) return { kind: "none", reason: "sign in with a Claude subscription using the isolated terminal command in Settings, or run /setup-bedrock for AWS" };
  return {
    kind: "extra", file: path.join(configDir, ".credentials.json"), configDir, home: os.homedir(),
    isolatedProvider: true, accessExpiresAt: Number(oauth.expiresAt) || 0,
    expiresAt: Number(oauth.refreshTokenExpiresAt) || 0,
    fingerprint: createHash("sha256").update(JSON.stringify(oauth)).digest("hex"), reason: "",
  };
}

export function extraClaudeCredentialState(options) {
  const provider = resolveExtraClaudeProvider(options);
  if (provider.kind === "bedrock") return bedrockCredentialState(options);
  return {
    known: true, authenticated: provider.configured, method: provider.configured ? "claude-subscription" : "none",
    detail: provider.configured ? "Separate Claude subscription login" : provider.error,
    source: provider.configDir || "", fingerprint: provider.login?.fingerprint || "",
  };
}

export async function resolveExtraClaudeToken({ configDir = bedrockLoginHome(), ...options } = {}) {
  const provider = resolveExtraClaudeProvider({ configDir, now: options.now });
  if (provider.kind !== "subscription" || !provider.configured) return { token: "", source: "none", error: provider.error || "The extra Claude harness is configured for Bedrock, not a subscription" };
  const { resolveContainerClaudeToken } = await import("../gateway/claude-token-relay.js");
  return resolveContainerClaudeToken({
    ...options, configured: () => "", env: {}, resolveLogin: () => provider.login,
    read: () => {
      const oauth = readExtraClaudeCredentials(configDir);
      return typeof oauth?.accessToken === "string" && oauth.accessToken.trim()
        ? { token: oauth.accessToken, expiresAt: Number(oauth.expiresAt) || 0 } : null;
    },
  });
}

export function makeBedrockAdapter(claude) {
  // Avoid inheriting any optional operation that resolves the default Anthropic account.
  const { updateSmoke: _updateSmoke, discoverModels: _discoverModels, subscriptionUsage: _subscriptionUsage, ...base } = claude;
  return validateEngineAdapter({
    ...base,
    id: BEDROCK_ENGINE_ID, label: "Claude Extra", modelFamily: "claude-extra",
    defaultModelKey: "defaultBedrockModel", defaultEffortKey: "defaultBedrockEffort",
    optIn: true, terminalSetup: true,
    models: [
      { value: "opus", label: "Opus", description: "Opus for this login, or the model pinned by your Bedrock setup." },
      { value: "sonnet", label: "Sonnet", description: "Sonnet for this login, or the model pinned by your Bedrock setup." },
      { value: "haiku", label: "Haiku", description: "Haiku for this login, or the model pinned by your Bedrock setup." },
      ...claude.models.filter((model) => !["opus", "sonnet", "haiku"].includes(model.value)),
    ],
    supports: { ...base.supports, warmPool: false, interruptSteer: false, realCost: false, usageLimitFallback: false },
    sessionState: Object.freeze({ ...base.sessionState, channelHistory: false, hostDir: () => bedrockLoginHome(), containerDirKey: "claudeBedrockConfigDir" }),
    modelBelongs: (model) => isBedrockModel(model) || claude.modelBelongs(model),
    resumeCommand(id, { target } = {}) {
      // A direct terminal exec holds no tracked SSH/VS Code lease, so the proxy correctly refuses
      // its relay while the channel is idle. A bare container `claude` also selects the independent
      // Anthropic child login. Fail explicitly rather than resume on the wrong provider/account.
      if (isIsolatedTarget(target)) {
        const message = "Bedrock terminal takeover is unavailable; continue this session in chat. Configure provider login using the host command in Settings.";
        return `sh -c ${shellQuote(`printf '%s\\n' ${shellQuote(message)} >&2; exit 1`)}`;
      }
      // On the host the CLI reads the wizard's isolated user settings itself. No bearer value
      // appears in the copied command; settings/tool policy for chat runs remains independent.
      return `env CLAUDE_CONFIG_DIR=${shellQuote(bedrockRuntimeConfigDir(target))} claude --resume ${shellQuote(id)}`;
    },
    compileConfinement(request = {}) {
      const network = compileNetworkPolicy({ engine: BEDROCK_ENGINE_ID, allowNetwork: Boolean(request.allowNetwork), supportedModes: NETWORK_MODES });
      return { supported: network.supported, reason: network.reason || "", network, writable: Boolean(request.writable), bypass: Boolean(request.dangerouslySkip) };
    },
    async run(ctx) {
      const r = ctx.runtime;
      requirePluginRuntime(r.pluginRuntime, BEDROCK_ENGINE_ID);
      const resolvedTarget = runtimeTargetOr(ctx.target, ctx.cwd);
      const configDir = bedrockRuntimeConfigDir(resolvedTarget);
      // Container exec applies its own final environment defaults after the runner's env. Carry
      // the provider's directory on the target too, so that last boundary preserves the same
      // transcript namespace. Never mutate the shared target that other engines may receive.
      const target = {
        ...resolvedTarget,
        meta: { ...resolvedTarget.meta, engine: BEDROCK_ENGINE_ID },
        ...(isIsolatedTarget(resolvedTarget) ? { container: { ...resolvedTarget.container, claudeConfigDir: configDir } } : {}),
      };
      const provider = resolveExtraClaudeProvider();
      if (!provider.configured) throw Object.assign(new Error(`The extra Claude harness is selected, but ${provider.error}.`), { details: { runtimeCredential: true, runtime: target.backend, engine: BEDROCK_ENGINE_ID } });
      const subscription = provider.kind === "subscription";
      if (r.model && !(subscription ? claude.modelBelongs(r.model) : isBedrockModel(r.model))) {
        throw new Error(`The selected model does not belong to this ${subscription ? "Claude subscription" : "Bedrock"} login; choose a matching model or opus, sonnet or haiku.`);
      }
      const { containerBedrockCredential, containerExtraClaudeCredential } = await import("../gateway/egress/grants.js");
      const relay = subscription ? await resolveExtraClaudeToken() : null;
      const credential = subscription ? containerExtraClaudeCredential({ target, relay }) : containerBedrockCredential({ target, provider });
      if (!credential.token) throw Object.assign(new Error(credential.error || "The Claude Bedrock credential is unavailable."), { details: { runtimeCredential: true, runtime: target.backend, engine: BEDROCK_ENGINE_ID } });
      const secrets = [subscription ? relay.token : provider.bearerToken];
      const stream = createSecretRedactor(secrets);
      try {
        const result = await runClaude({
          cwd: ctx.cwd, prompt: ctx.prompt, sessionId: ctx.session.id, isNewSession: ctx.session.fresh,
          forkSourceSessionId: r.forkSourceSessionId,
          mcpConfig: r.mcpConfigFile, strictMcp: r.strictMcp, dangerouslySkip: r.dangerouslySkip,
          settingsFile: r.settingsFile, model: r.model, effort: r.effort,
          timeoutMs: r.timeoutMs, maxSilenceMs: r.maxSilenceMs, signal: r.signal,
          onDelta: r.onDelta ? (chunk) => { const safe = stream.push(chunk); if (safe) r.onDelta(safe); } : null,
          onEvent: r.onEvent ? (event) => r.onEvent(redactSecretFields(event, secrets)) : null,
          onSessionResolved: r.onSessionResolved,
          permissionPromptTool: r.permissionPromptTool, pluginDirs: r.claudePluginDirs,
          instructionFile: r.instructionFile, disallowedTools: r.disallowedTools,
          extraEnv: r.channelEnv, browserNamespace: r.browserNamespace, target,
          engineId: BEDROCK_ENGINE_ID, harnessLabel: "Claude Extra", claudeOauthToken: "",
          providerEnv: subscription
            ? { CLAUDE_CODE_OAUTH_TOKEN: credential.token, CLAUDE_CONFIG_DIR: configDir }
            : { ...provider.env, AWS_BEARER_TOKEN_BEDROCK: credential.token, CLAUDE_CONFIG_DIR: configDir },
        });
        // Claude Code's price table cannot establish an AWS bill (regions and inference profiles
        // price differently). Keep real token counts; leave dollar cost unknown.
        return { ...redactSecretFields(result, secrets), costUSD: null };
      } catch (error) {
        if (typeof error.message === "string") error.message = redactSecretValues(error.message, secrets);
        if (typeof error.stack === "string") error.stack = redactSecretValues(error.stack, secrets);
        if (error.details) error.details = redactSecretFields(error.details, secrets);
        throw error;
      } finally {
        const tail = stream.flush();
        if (tail) r.onDelta?.(tail);
      }
    },
    interrupt: () => false,
    credentialState: () => extraClaudeCredentialState(),
    // Enabling the option is independent of selecting it for a turn/default. A missing terminal
    // setup must not replace a channel's working runtime selection.
    selectionReadiness: () => { const provider = resolveExtraClaudeProvider(); return { ready: provider.configured, reason: provider.error }; },
    async health(options) {
      const baseHealth = await commandHealth("claude", options);
      const { fingerprint: _fingerprint, source: _source, ...auth } = extraClaudeCredentialState();
      return { ...baseHealth, auth };
    },
  });
}
