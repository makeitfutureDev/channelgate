import { runClaude, buildClaudeEnv, buildPersistentArgs, canUseClaudeWarmPool } from "./claude.js";
import { runCodex } from "./codex.js";
import { runOpenCode } from "./opencode.js";
import { runPooled, abortPooled } from "./session-pool.js";
import { compileNetworkPolicy } from "./network-policy.js";
import { listEngineMcps, codexMcpPolicyFor } from "../gateway/mcp-discovery.js";
import { commandHealth, validateEngineAdapter } from "./contract.js";
import { readCodexAuthState } from "./codex-auth.js";
import { codexEngineHome } from "../config/paths.js";

// Full network capability, shared by the two OS-sandboxed engines. Each adapter passes ITS OWN
// declared modes into the compiler, so supports.networkModes is the single source of truth.
const FULL_NETWORK_MODES = Object.freeze(["off", "approved", "unrestricted"]);

const baseCompile = (engine, request = {}, supportedModes = ["off"]) => {
  const network = compileNetworkPolicy({ engine, allowNetwork: Boolean(request.allowNetwork), dangerouslySkip: Boolean(request.dangerouslySkip), allowedDomains: request.allowedDomains || [], supportedModes });
  return { supported: network.supported, reason: network.reason || "", network, writable: Boolean(request.writable), bypass: Boolean(request.dangerouslySkip) };
};

const claude = validateEngineAdapter({
  id: "claude", label: "Claude", cli: "claude", defaultModelKey: "defaultClaudeModel", mcpMetaKey: "allowedMcps",
  instructionFile: "CLAUDE.md", skillsDir: ".claude/skills", mcpTransport: "file", contextWindow: 200_000,
  efforts: ["low", "medium", "high", "xhigh"], models: [
    { label: "Opus", value: "opus", description: "Claude Opus alias." },
    { label: "Opus 1M", value: "opus[1m]", description: "Claude Opus with the 1M context alias." },
    { label: "Fable 5", value: "claude-fable-5", description: "Claude Fable 5." },
    { label: "Sonnet", value: "sonnet", description: "Claude Sonnet alias." },
    { label: "Haiku", value: "haiku", description: "Claude Haiku alias." },
  ], mintsOwnSessionId: false,
  supports: { warmPool: true, interruptSteer: true, permissionPrompt: true, compact: true, realCost: true, usageLimitFallback: true, userSkillOverlay: true, settingsFile: true, networkModes: FULL_NETWORK_MODES },
  modelBelongs: (m) => /^(?:opus|sonnet|haiku|opusplan)(?:\[1m\])?$|^claude-/.test(m),
  resumeCommand: (id) => `claude --resume ${id}`,
  compileConfinement: (request) => baseCompile("claude", request, FULL_NETWORK_MODES),
  async run(ctx) {
    const r = ctx.runtime;
    const idleMs = canUseClaudeWarmPool(r) ? r.keepAliveMs : 0;
    if (idleMs > 0) {
      const args = buildPersistentArgs({ sessionId: ctx.session.id, isNewSession: ctx.session.fresh, mcpConfig: r.mcpConfigFile, strictMcp: r.strictMcp, dangerouslySkip: r.dangerouslySkip, settingsFile: r.settingsFile, model: r.model, effort: r.effort, permissionPromptTool: r.permissionPromptTool, pluginDirs: r.claudePluginDirs, instructionFile: r.instructionFile });
      const isolationFingerprint = JSON.stringify({
        settingsFile: r.settingsFile,
        instructionFile: r.instructionFile,
        pluginDirs: r.claudePluginDirs || [],
        home: r.claudeHome,
        configDir: r.claudeConfigDir,
        grants: r.grantFingerprint || "",
      });
      return runPooled({ key: r.poolKey, cwd: ctx.cwd, args, env: buildClaudeEnv({ home: r.claudeHome, configDir: r.claudeConfigDir }), idleMs, mcpConfigJson: r.mcpConfigFingerprint || r.mcpConfigJson, dangerouslySkip: r.dangerouslySkip, fingerprintExtra: `${r.model}|${r.effort}|${r.permissionPromptTool}|${isolationFingerprint}`, text: ctx.prompt, turnTimeoutMs: r.timeoutMs, maxSilenceMs: r.maxSilenceMs, signal: r.signal, onDelta: r.onDelta, onEvent: r.onEvent });
    }
    return runClaude({ cwd: ctx.cwd, prompt: ctx.prompt, sessionId: ctx.session.id, isNewSession: ctx.session.fresh, mcpConfig: r.mcpConfigFile, strictMcp: r.strictMcp, dangerouslySkip: r.dangerouslySkip, settingsFile: r.settingsFile, model: r.model, effort: r.effort, timeoutMs: r.timeoutMs, maxSilenceMs: r.maxSilenceMs, signal: r.signal, onDelta: r.onDelta, onEvent: r.onEvent, permissionPromptTool: r.permissionPromptTool, pluginDirs: r.claudePluginDirs, instructionFile: r.instructionFile, home: r.claudeHome, configDir: r.claudeConfigDir });
  },
  interrupt: ({ poolKey }) => abortPooled(poolKey),
  discoverMcps: () => listEngineMcps("claude"),
  health: (options) => commandHealth("claude", options),
});

const codex = validateEngineAdapter({
  id: "codex", label: "Codex", cli: "codex", defaultModelKey: "defaultCodexModel", mcpMetaKey: "allowedCodexMcps",
  instructionFile: "AGENTS.md", skillsDir: ".agents/skills", mcpTransport: "argv", contextWindow: 272_000,
  efforts: ["none", "low", "medium", "high", "xhigh", "max"], models: [
    ...["codex", "gpt-5.6-sol", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"].map((value) => ({ label: value === "codex" ? "Codex" : value.toUpperCase().replace("GPT-", "GPT-"), value, description: `${value} model.` })),
  ], mintsOwnSessionId: true,
  supports: { warmPool: false, interruptSteer: false, permissionPrompt: false, compact: false, realCost: false, usageLimitFallback: true, userSkillOverlay: true, networkModes: FULL_NETWORK_MODES },
  modelBelongs: (m) => /^(?:gpt-|o[0-9]|codex)/.test(m),
  resumeCommand: (id) => `codex exec resume ${id}`,
  compileConfinement: (request) => baseCompile("codex", request, FULL_NETWORK_MODES),
  async run(ctx) {
    const r = ctx.runtime;
    const catalog = await listEngineMcps("codex").catch(() => []);
    const codexMcpPolicy = codexMcpPolicyFor(catalog, r.allowedMcps || []);
    const unsafe = codexMcpPolicy.servers.find((server) => server.enabled && !server.definition);
    if (unsafe) throw new Error(`Optional MCP ${unsafe.name} has no complete credential-safe definition; refusing Codex run`);
    return runCodex({ cwd: ctx.cwd, prompt: ctx.prompt, sessionId: ctx.session.id, isNewSession: ctx.session.fresh, dangerouslySkip: r.dangerouslySkip, writable: r.writable, networkMode: ctx.policy.network.mode, networkDomains: ctx.policy.network.domains || [], clean: r.clean, autoApprove: r.autoApprove, composioUserEndpoint: r.composioUserEndpoint, composioEndpoint: r.composioEndpoint, composioUserToken: r.composioUserToken, composioToken: r.composioToken, skillsToken: r.skillsToken, toolboxToken: r.toolboxToken, makeToolboxUrl: r.makeToolboxUrl, makeToolboxKey: r.makeToolboxKey, codexMcpPolicy, gatewayCapability: r.gatewayCapability, gatewayFsRoot: r.gatewayFsRoot, gatewayWorkspaceRoot: r.gatewayWorkspaceRoot, progressReport: r.progressReport, model: r.model, effort: r.effort, codexUserHome: r.codexUserHome, codexHome: r.codexHome, codexStateDir: r.codexStateDir, codexSkillSupportDir: r.codexSkillSupportDir, codexCredentialPaths: r.codexCredentialPaths, attachments: r.attachments, signal: r.signal, timeoutMs: r.timeoutMs, maxSilenceMs: r.maxSilenceMs, onDelta: r.onDelta, onEvent: r.onEvent });
  },
  interrupt: () => false,
  discoverMcps: () => listEngineMcps("codex"),
  // Optional per-engine fact: "is this harness's credential usable right now, and is it the SAME
  // one that failed?" The orchestrator only ever compares the opaque fingerprint, so an engine
  // that cannot answer simply doesn't declare this hook.
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
        network: { mode: request.dangerouslySkip ? "unrestricted" : request.allowNetwork ? "approved" : "off", supported: false },
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
      signal: runtime.signal, onDelta: runtime.onDelta, onEvent: runtime.onEvent });
  },
  interrupt: () => false,
  discoverMcps: async () => [],
  health: (options) => commandHealth("opencode", options),
});

export const BUILTIN_ENGINE_ADAPTERS = Object.freeze([claude, codex, opencode]);
