import path from "node:path";
import { resolveClaudeMcpConfig } from "./claude-mcp.js";
import { runClaude, buildClaudeEnv, buildPersistentArgs, canUseClaudeWarmPool } from "./claude.js";
import { runCodex } from "./codex.js";
import { runOpenCode } from "./opencode.js";
import { runPooled, abortPooled } from "./session-pool.js";
import { compileNetworkPolicy } from "./network-policy.js";
import { listEngineMcps, codexMcpPolicyFor } from "../gateway/mcp-discovery.js";
import { commandHealth, validateEngineAdapter } from "./contract.js";
import { runtimeTargetOr } from "./runtime-target.js";
import { readCodexAuthState } from "./codex-auth.js";
import { claudeEngineHome, codexEngineHome } from "../config/paths.js";
import { discoverCodexModels } from "./model-discovery.js";
import { requirePluginRuntime } from "../gateway/plugin-runtime.js";

// Which Claude login the gateway is using (src/gateway/claude-login.js). Imported LAZILY: that
// module reads a setting, src/config/settings.js imports the engine registry, and the registry
// imports this file — a static import would close that cycle and leave `BUILTIN_ENGINE_ADAPTERS` in
// its temporal dead zone. Same pattern the platform adapters use for their own settings reads.
async function claudeLogin() {
  const { resolveClaudeLogin } = await import("../gateway/claude-login.js");
  return resolveClaudeLogin();
}

// ── Where a harness keeps a SESSION's own transcript (the `sessionState` fact) ─────────────────
// A session id is only half the story: resuming a thread also needs the engine's own files, and
// those live in the engine's state dir, which is a different directory when the run happens inside
// a container. Each adapter therefore declares three things and nothing more:
//   hostDir()          the state dir on the daemon's filesystem
//   containerDirKey    the key on `target.container` that names the SAME directory in an image
//                      (set by src/runtimes/container/image-paths.js — read off the target rather
//                      than imported, because src/engines/ does not depend on src/runtimes/)
//   files({cwd, sessionId})  the paths, RELATIVE to that dir, this session's history occupies
// A `rel` may carry `*` inside a segment; the carry expands it on whichever side owns the files.
// src/gateway/session-carry.js is the only consumer.

// Claude keys a project's transcripts by its working directory with every non-alphanumeric
// character replaced by a dash — the same rule Claude Code itself applies, verified against a live
// ~/.claude/projects. Derived from the RUN's cwd, so clean mode (which runs in the bare clean
// workspace) keys the directory it actually ran in.
function claudeProjectKey(cwd) {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

// Full network capability, shared by the two container-run engines. Each adapter passes ITS OWN
// declared modes into the compiler, so supports.networkModes is the single source of truth.
const FULL_NETWORK_MODES = Object.freeze(["off", "on"]);

const baseCompile = (engine, request = {}, supportedModes = ["off"]) => {
  const network = compileNetworkPolicy({ engine, allowNetwork: Boolean(request.allowNetwork), supportedModes });
  return { supported: network.supported, reason: network.reason || "", network, writable: Boolean(request.writable), bypass: Boolean(request.dangerouslySkip) };
};

const claude = validateEngineAdapter({
  pluginCapabilities: { manifest: "claude", components: ["skills", "commands", "agents", "hooks", "mcpServers"] },
  resolveOptionalMcpConfig: resolveClaudeMcpConfig,
  id: "claude", label: "Claude", cli: "claude", defaultModelKey: "defaultClaudeModel", mcpMetaKey: "allowedMcps",
  instructionFile: "CLAUDE.md", skillsDir: ".claude/skills", mcpTransport: "file", contextWindow: 200_000,
  efforts: ["low", "medium", "high", "xhigh"], models: [
    { label: "Best", value: "best", description: "Claude's current best model for this account." },
    { label: "Opus", value: "opus", description: "Claude Opus alias." },
    { label: "Opus 1M", value: "opus[1m]", description: "Claude Opus with the 1M context alias." },
    { label: "Sonnet", value: "sonnet", description: "Claude Sonnet alias." },
    { label: "Sonnet 1M", value: "sonnet[1m]", description: "Claude Sonnet with the 1M context alias." },
    { label: "Haiku", value: "haiku", description: "Claude Haiku alias." },
    { label: "Fable", value: "fable", description: "Claude Fable alias." },
    { label: "Opus plan", value: "opusplan", description: "Use Opus for planning and Sonnet for execution." },
  ], mintsOwnSessionId: false,
  modelCatalogSource: "aliases",
  // Provider-failure kinds (stream.js claudeProviderError) the orchestrator may replay IN PLACE on
  // this engine: the provider did not answer the request. Never the limit/credential kinds (their
  // own failover) and never the catch-all "provider" (a rejected request fails the same way twice).
  transientKinds: Object.freeze(["availability", "connection"]),
  supports: { warmPool: true, interruptSteer: true, permissionPrompt: true, compact: true, realCost: true, usageLimitFallback: true, userSkillOverlay: true, settingsFile: true, networkModes: FULL_NETWORK_MODES },
  modelBelongs: (m) => /^(?:best|fable|haiku|opusplan|opus|sonnet|(?:opus|sonnet)\[1m\])$|^claude-/.test(m),
  resumeCommand: (id) => `claude --resume ${id}`,
  sessionState: Object.freeze({
    // CLAUDE_CONFIG_DIR on the host is the gateway's stable synthetic one (run-grant-artifacts.js
    // plants `projects` in it as a symlink to the operator's real directory, which the copy
    // follows as an ancestor).
    hostDir: () => path.join(claudeEngineHome(), ".claude"),
    containerDirKey: "claudeConfigDir",
    files: ({ cwd, sessionId }) => {
      const key = claudeProjectKey(cwd);
      return [
        { rel: `projects/${key}/${sessionId}.jsonl`, kind: "file" },
        // Subagent transcripts for the same session, when the turn used any. Optional by nature —
        // a session that never spawned one has no such directory, and a missing source carries 0.
        { rel: `projects/${key}/${sessionId}`, kind: "dir" },
      ];
    },
  }),
  compileConfinement: (request) => baseCompile("claude", request, FULL_NETWORK_MODES),
  async run(ctx) {
    const r = ctx.runtime;
    requirePluginRuntime(r.pluginRuntime, this.id);
    // WHERE this turn runs (src/runtimes/): the channel's container, resolved once per turn by
    // run.js and put on the context.
    const target = runtimeTargetOr(ctx.target, ctx.cwd);
    // The gateway relays the ACCESS token of whichever login it resolved (src/gateway/claude-login.js
    // — the operator's own ~/.claude first), because a container has no login of its own.
    const claudeOauthToken = ctx.claudeOauthToken ?? r.claudeOauthToken ?? "";
    const idleMs = canUseClaudeWarmPool(r) ? r.keepAliveMs : 0;
    if (idleMs > 0) {
      const args = buildPersistentArgs({ sessionId: ctx.session.id, isNewSession: ctx.session.fresh, mcpConfig: r.mcpConfigFile, strictMcp: r.strictMcp, dangerouslySkip: r.dangerouslySkip, settingsFile: r.settingsFile, model: r.model, effort: r.effort, permissionPromptTool: r.permissionPromptTool, pluginDirs: r.claudePluginDirs, instructionFile: r.instructionFile });
      const isolationFingerprint = JSON.stringify({
        settingsFile: r.settingsFile,
        // The channel's environment secrets, as a DIGEST (gateway/run.js). A warm process holds
        // the environment it was started with, so a rotated secret must retire it — otherwise the
        // pool keeps answering with the credential the operator just replaced.
        channelEnv: r.channelEnvFingerprint || "",
        // Same reason, no digest needed: this one is not a secret, and a pooled process that
        // kept an older namespace would drive another channel's browser daemon.
        browserNamespace: r.browserNamespace || "",
        // WHERE the process runs is fingerprinted by the pool itself (session-pool.js), from the
        // backend's own create-time digest.
        instructionFile: r.instructionFile,
        pluginDirs: r.claudePluginDirs || [],
        // The relayed login, as its SOURCE + the expiry of the token this turn was handed (never
        // the token text — see gateway/claude-token-relay.claudeTokenFingerprint). A warm process
        // holds the environment it launched with and an env token has no refresh half, so a
        // refreshed token must retire it or the pool keeps presenting one that is about to die.
        claudeToken: r.claudeTokenFingerprint || "",
      });
      // The warm process never learns the model it was started with; a provider failure it reports
      // still needs `requestedModel` for the same-engine model retry (see gateway/run.js).
      return runPooled({ key: r.poolKey, cwd: ctx.cwd, args, env: buildClaudeEnv({ extraEnv: r.channelEnv, browserNamespace: r.browserNamespace, target, oauthToken: claudeOauthToken }), idleMs, target, mcpConfigJson: r.mcpConfigFingerprint || r.mcpConfigJson, dangerouslySkip: r.dangerouslySkip, fingerprintExtra: `${r.model}|${r.effort}|${r.permissionPromptTool}|${isolationFingerprint}`, text: ctx.prompt, turnTimeoutMs: r.timeoutMs, maxSilenceMs: r.maxSilenceMs, signal: r.signal, onDelta: r.onDelta, onEvent: r.onEvent }).catch((error) => {
        if (error?.details?.providerError === true && error.details.requestedModel === undefined) error.details.requestedModel = r.model;
        throw error;
      });
    }
    return runClaude({ cwd: ctx.cwd, prompt: ctx.prompt, sessionId: ctx.session.id, isNewSession: ctx.session.fresh, mcpConfig: r.mcpConfigFile, strictMcp: r.strictMcp, dangerouslySkip: r.dangerouslySkip, settingsFile: r.settingsFile, model: r.model, effort: r.effort, timeoutMs: r.timeoutMs, maxSilenceMs: r.maxSilenceMs, signal: r.signal, onDelta: r.onDelta, onEvent: r.onEvent, permissionPromptTool: r.permissionPromptTool, pluginDirs: r.claudePluginDirs, instructionFile: r.instructionFile, extraEnv: r.channelEnv, browserNamespace: r.browserNamespace, target, claudeOauthToken });
  },
  interrupt: ({ poolKey }) => abortPooled(poolKey),
  discoverMcps: () => listEngineMcps("claude"),
  // Same optional hook Codex declares: "is this harness's credential usable right now, and is it
  // the SAME one that failed?". `authenticated` is true whenever the gateway resolved SOME usable
  // login (the operator's own, a gateway sign-in, a setup-token or the daemon's API key); the
  // fingerprint is opaque and the orchestrator only ever compares it.
  async updateSmoke(args) {
    const { resolveContainerClaudeToken } = await import("../gateway/claude-token-relay.js");
    const relay = await resolveContainerClaudeToken({ minFreshMs: 0, refresh: async () => {
      throw new Error("Claude login expired; refresh the operator login before updating");
    } });
    if (!relay.token && relay.source !== "api-key") throw new Error(relay.error || "Claude login is unavailable");
    return runClaude({ ...args, claudeOauthToken: relay.token });
  },
  async credentialState() {
    const login = await claudeLogin();
    return {
      known: true,
      authenticated: login.kind !== "none",
      method: login.kind,
      detail: login.detail,
      source: login.file,
      fingerprint: login.fingerprint,
    };
  },
  // `claude --version` answers "is the CLI installed", which stays true with no login at all — so
  // the login is probed too and reported beside it. It never flips `ready`: boot logs and the admin
  // rail say WHICH login is in use and when it dies, instead of leaving that to be inferred from
  // turns that quietly fail over.
  async health(options) {
    const base = await commandHealth("claude", options);
    let auth = { known: false, authenticated: false, method: "", detail: "" };
    try {
      const [{ describeClaudeLogin, claudeLoginExpiryWarning }, login] = await Promise.all([
        import("../gateway/claude-login.js"),
        claudeLogin(),
      ]);
      const described = describeClaudeLogin(login);
      const expiring = claudeLoginExpiryWarning(login);
      auth = {
        known: true,
        authenticated: login.kind !== "none",
        method: login.kind,
        detail: expiring || described.detail,
        login: described,
        ...(expiring ? { expiring } : {}),
      };
    } catch (error) {
      auth = { known: false, authenticated: false, method: "", detail: String(error?.message || error) };
    }
    return { ...base, auth };
  },
});

const codex = validateEngineAdapter({
  pluginCapabilities: { sourceManifest: "codex", manifest: "", components: ["skills", "mcpServers"] },
  async resolveOptionalMcpConfig(allowed) {
    if (!Array.isArray(allowed) || !allowed.length) return {};
    const policy = codexMcpPolicyFor(await listEngineMcps("codex"), allowed);
    return Object.fromEntries(policy.servers.filter((server) => server.enabled).map((server) => {
      const definition = server.definition;
      if (!definition) throw new Error(`Optional MCP ${server.name} has no complete credential-safe definition; refusing Codex run`);
      return [server.name, definition.transport === "http" ? { type: "http", url: definition.url } : { command: definition.command, args: definition.args || [] }];
    }));
  },
  id: "codex", label: "Codex", cli: "codex", defaultModelKey: "defaultCodexModel", mcpMetaKey: "allowedCodexMcps",
  instructionFile: "AGENTS.md", skillsDir: ".agents/skills", mcpTransport: "argv", contextWindow: 272_000,
  efforts: ["none", "low", "medium", "high", "xhigh", "max", "ultra"], models: [
    ...["codex", "gpt-5.6-sol", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"].map((value) => ({ label: value === "codex" ? "Codex" : value.toUpperCase().replace("GPT-", "GPT-"), value, description: `${value} model.` })),
  ], mintsOwnSessionId: true,
  // The runner's own "the provider did not answer" kind (classifyCodexFailure), replayable in place.
  transientKinds: Object.freeze(["transient"]),
  supports: { warmPool: false, interruptSteer: false, permissionPrompt: false, compact: false, realCost: false, usageLimitFallback: true, userSkillOverlay: true, networkModes: FULL_NETWORK_MODES },
  modelBelongs: (m) => /^(?:gpt-|o[0-9]|codex)/.test(m),
  resumeCommand: (id) => `codex exec resume ${id}`,
  sessionState: Object.freeze({
    // codexEngineHome() already ends in `.codex`, and IS $CODEX_HOME for every gateway run.
    hostDir: () => codexEngineHome(),
    containerDirKey: "codexHome",
    // A rollout is `sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`. The timestamp cannot be
    // recomputed, so the location is a PATTERN — and the date directories must survive the copy,
    // because that tree is how `codex exec resume <id>` finds the file.
    files: ({ sessionId }) => [{ rel: `sessions/*/*/*/*-${sessionId}.jsonl`, kind: "file" }],
  }),
  compileConfinement: (request) => baseCompile("codex", request, FULL_NETWORK_MODES),
  async run(ctx) {
    const r = ctx.runtime;
    requirePluginRuntime(r.pluginRuntime, this.id);
    const target = runtimeTargetOr(ctx.target, ctx.cwd);
    const catalog = await listEngineMcps("codex").catch(() => []);
    const codexMcpPolicy = codexMcpPolicyFor(catalog, r.allowedMcps || []);
    codexMcpPolicy.servers.push(...(r.pluginMcpServers || []));
    const unsafe = codexMcpPolicy.servers.find((server) => server.enabled && !server.definition);
    if (unsafe) throw new Error(`Optional MCP ${unsafe.name} has no complete credential-safe definition; refusing Codex run`);
    return runCodex({ cwd: ctx.cwd, prompt: ctx.prompt, extraEnv: r.channelEnv, browserNamespace: r.browserNamespace, sessionId: ctx.session.id, isNewSession: ctx.session.fresh, dangerouslySkip: r.dangerouslySkip, writable: r.writable, networkMode: ctx.policy.network.mode, clean: r.clean, autoApprove: r.autoApprove, composioUserEndpoint: r.composioUserEndpoint, composioEndpoint: r.composioEndpoint, composioUserToken: r.composioUserToken, composioToken: r.composioToken, toolboxToken: r.toolboxToken, makeToolboxUrl: r.makeToolboxUrl, makeToolboxKey: r.makeToolboxKey, codexMcpPolicy, gatewayCapability: r.gatewayCapability, gatewayFsRoot: r.gatewayFsRoot, gatewayWorkspaceRoot: r.gatewayWorkspaceRoot, progressReport: r.progressReport, model: r.model, effort: r.effort, codexStateDir: r.codexStateDir, personalSkills: r.personalSkillCatalog, pluginSkills: requirePluginRuntime(r.pluginRuntime, this.id).skills, attachments: r.attachments, target, artifactDir: ctx.artifactDir ?? target.artifactDir ?? null, signal: r.signal, timeoutMs: r.timeoutMs, maxSilenceMs: r.maxSilenceMs, onDelta: r.onDelta, onEvent: r.onEvent, onSessionResolved: r.onSessionResolved });
  },
  interrupt: () => false,
  discoverMcps: () => listEngineMcps("codex"),
  // Run against the daemon's own Codex environment: container channels share that operator login,
  // and `CODEX_HOME` (when explicitly configured) remains authoritative.
  discoverModels: () => discoverCodexModels(),
  // Optional per-engine fact: "is this harness's credential usable right now, and is it the SAME
  // one that failed?" The orchestrator only ever compares the opaque fingerprint, so an engine
  // that cannot answer simply doesn't declare this hook.
  updateSmoke: (args) => runCodex({ ...args, clean: true, writable: false, networkMode: "off", artifactDir: args.target.artifactDir }),
  credentialState: () => readCodexAuthState({ codexHome: codexEngineHome() }),
  // `codex --version` answers "is the CLI installed", which stays true for a logged-OUT host — so
  // the credential is probed too. It never flips `ready` (an unauthenticated CLI is still present,
  // and the run path fails over on its own); it is reported so boot logs and the admin rail can
  // say "signed out" instead of leaving the operator to infer it from stalled turns.
  async health(options) {
    const base = await commandHealth("codex", options);
    const auth = await readCodexAuthState({ codexHome: codexEngineHome() }).catch((error) => ({
      known: false, authenticated: false, method: "", detail: String(error?.message || error), source: "",
    }));
    return { ...base, auth: { known: auth.known, authenticated: auth.authenticated, method: auth.method, detail: auth.detail } };
  },
});

const opencode = validateEngineAdapter({
  id: "opencode", label: "OpenCode (read-only)", cli: "opencode", defaultModelKey: "defaultOpenCodeModel",
  mcpMetaKey: "allowedOpenCodeMcps", instructionFile: "AGENTS.md", skillsDir: ".opencode/skills",
  mcpTransport: "none", contextWindow: 200_000, efforts: ["low", "medium", "high"], models: [],
  mintsOwnSessionId: true,
  transientKinds: Object.freeze([]), // its runner classifies no provider failures yet
  supports: { warmPool: false, interruptSteer: false, permissionPrompt: false, compact: false,
    realCost: true, usageLimitFallback: false, userSkillOverlay: false, networkModes: ["off"], readOnly: true, mcp: false },
  // OpenCode model IDs are provider/model. An empty value deliberately delegates to its configured
  // default; non-empty IDs must retain the provider boundary.
  modelBelongs: (model) => /^[a-z0-9._-]+\/[a-z0-9._:/-]+$/i.test(model),
  resumeCommand: (id) => `opencode run --session ${id}`,
  compileConfinement(request = {}) {
    if (request.dangerouslySkip || request.writable || request.allowNetwork) {
      return {
        supported: false,
        reason: "OpenCode is admitted only for read-only, network-off runs because its permission rules are not an OS sandbox",
        network: { mode: request.allowNetwork ? "on" : "off", supported: false },
        writable: false,
        bypass: false,
      };
    }
    return { supported: true, reason: "", network: { mode: "off", supported: true }, writable: false, bypass: false };
  },
  async run(ctx) {
    const runtime = ctx.runtime;
    if (ctx.policy.writable || ctx.policy.network?.mode !== "off" || runtime.allowedMcps?.length) {
      throw new Error("OpenCode adapter refused unsupported write, network, or MCP capability");
    }
    return runOpenCode({ cwd: ctx.cwd, prompt: ctx.prompt, sessionId: ctx.session.id,
      isNewSession: ctx.session.fresh, model: runtime.model, effort: runtime.effort,
      attachments: runtime.attachments, timeoutMs: runtime.timeoutMs, maxSilenceMs: runtime.maxSilenceMs,
      target: runtimeTargetOr(ctx.target, ctx.cwd),
      signal: runtime.signal, onDelta: runtime.onDelta, onEvent: runtime.onEvent });
  },
  interrupt: () => false,
  discoverMcps: async () => [],
  health: (options) => commandHealth("opencode", options),
});

export const BUILTIN_ENGINE_ADAPTERS = Object.freeze([claude, codex, opencode]);
