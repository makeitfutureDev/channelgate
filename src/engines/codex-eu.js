// An isolated ChatGPT login using the existing Codex runner. Residency remains a workspace
// policy: selecting this harness never changes or proves the workspace's configured region.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { commandHealth, validateEngineAdapter } from "./contract.js";
import { readCodexAuthState } from "./codex-auth.js";
import { discoverCodexModels } from "./model-discovery.js";
import { codexAuthProcessEnv, codexEuLoginHome, codexEuLoginHint } from "../gateway/channel-codex-paths.js";
export { codexEuLoginHome, codexEuLoginHint } from "../gateway/channel-codex-paths.js";

// "Is this isolated ChatGPT login usable?" for ANY dedicated login directory: Codex EU's, and each
// Codex license's (license-adapters.js). `planType` is the plan the sign-in itself reports, which
// is what a license's declared type is verified against.
export async function dedicatedCodexCredentialState({ home, label = "Codex EU", loginHint = "", readFileImpl = readFile } = {}) {
  const state = await readCodexAuthState({ codexHome: home, hostCodexHome: home, env: {}, readFileImpl });
  const remedy = `run \`${loginHint}\` on the gateway host and choose the intended ChatGPT workspace`;
  if (!state.known || !state.authenticated) return { ...state, authenticated: false, detail: remedy };
  if (state.method !== "chatgpt") return { ...state, authenticated: false, detail: `${label} requires a ChatGPT sign-in; ${remedy}` };
  let planType = "";
  try {
    const parsed = JSON.parse(await readFileImpl(path.join(home, "auth.json"), "utf8"));
    const claims = JSON.parse(Buffer.from(String(parsed.tokens?.access_token || "").split(".")[1] || "", "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error("invalid access-token claims");
    planType = String(claims["https://api.openai.com/auth"]?.chatgpt_plan_type || "");
  } catch {
    return { ...state, authenticated: false, detail: `the dedicated ChatGPT login could not be verified; ${remedy}` };
  }
  return { ...state, planType };
}

export function codexEuCredentialState({ readFileImpl = readFile } = {}) {
  return dedicatedCodexCredentialState({ home: codexEuLoginHome(), label: "Codex EU", loginHint: codexEuLoginHint(), readFileImpl });
}

export function makeCodexEuAdapter(base) {
  return validateEngineAdapter({
    ...base,
    subscriptionUsage: { provider: "codex", login: "codex-eu" },
    id: "codex-eu", label: "Codex EU", terminalSetup: true, optIn: true, modelFamily: "codex", defaultModelKey: "defaultCodexEuModel",
    defaultEffortKey: "defaultCodexEuEffort", mcpMetaKey: "allowedCodexEuMcps",
    supports: { ...base.supports, usageLimitFallback: false },
    resumeCommand(id, { target = null } = {}) {
      const home = target?.runtime?.capabilities?.isolated === true || target?.backend === "container"
        ? target?.container?.codexEuHome || `${target?.container?.home || "/home/agent"}/.codex-eu`
        : codexEuLoginHome();
      return `env CODEX_HOME='${home.replaceAll("'", "'\\''")}' codex exec resume '${String(id).replaceAll("'", "'\\''")}'`;
    },
    sessionState: { ...base.sessionState, channelHistory: false, hostDir: codexEuLoginHome, containerDirKey: "codexEuHome" },
    // Default Codex MCP account configuration must not cross into this isolated login.
    discoverMcps: async () => [],
    resolveOptionalMcpConfig: async () => ({ servers: {}, rejected: [] }),
    async discoverModels() {
      const state = await codexEuCredentialState();
      if (!state.authenticated) throw new Error(state.detail);
      return discoverCodexModels({ env: codexAuthProcessEnv(codexEuLoginHome()) });
    },
    credentialState: codexEuCredentialState,
    async selectionReadiness() {
      const auth = await codexEuCredentialState();
      return { ready: auth.authenticated === true, reason: auth.detail };
    },
    async health(options) {
      const cli = await commandHealth("codex", options);
      const auth = await codexEuCredentialState();
      return { ...cli, auth: { known: auth.known, authenticated: auth.authenticated, method: auth.method, detail: auth.detail } };
    },
    async run(ctx) {
      const auth = await codexEuCredentialState();
      if (!auth.authenticated) throw Object.assign(new Error(`Codex EU is not configured: ${auth.detail}`), {
        details: { engine: this.id, providerKind: "authentication", providerError: true, replaySafe: true, toolUseCount: 0 },
      });
      const target = ctx.target;
      const euTarget = { ...target, meta: { ...target?.meta, engine: this.id, codexHarness: "eu" },
        ...(target?.container ? { container: { ...target.container, codexHome: target.container.codexEuHome || `${target.container.home || "/home/agent"}/.codex-eu` } } : {}) };
      try {
        return await base.run.call(this, { ...ctx, target: euTarget, runtime: { ...ctx.runtime,
          allowedMcps: [], codexStateDir: target?.backend === "container" ? "" : codexEuLoginHome() } });
      } catch (error) {
        if (error?.details) error.details = { ...error.details, engine: this.id };
        throw error;
      }
    },
    updateSmoke: undefined,
  });
}
