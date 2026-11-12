// An isolated Enterprise login using the existing Codex runner. Residency remains a workspace
// policy: selecting this harness never changes or proves the workspace's configured region.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { commandHealth, validateEngineAdapter } from "./contract.js";
import { readCodexAuthState } from "./codex-auth.js";
import { discoverCodexModels } from "./model-discovery.js";
import { codexAuthProcessEnv, codexEuLoginHome, codexEuLoginHint } from "../gateway/channel-codex-paths.js";
export { codexEuLoginHome, codexEuLoginHint } from "../gateway/channel-codex-paths.js";

export async function codexEuCredentialState({ readFileImpl = readFile } = {}) {
  const home = codexEuLoginHome();
  const state = await readCodexAuthState({ codexHome: home, hostCodexHome: home, env: {}, readFileImpl });
  const remedy = `run \`${codexEuLoginHint()}\` on the gateway host and choose the Enterprise EU workspace`;
  if (!state.known || !state.authenticated) return { ...state, authenticated: false, detail: remedy };
  if (state.method !== "chatgpt") return { ...state, authenticated: false, detail: `Codex EU requires a ChatGPT Enterprise sign-in; ${remedy}` };
  try {
    const parsed = JSON.parse(await readFileImpl(path.join(home, "auth.json"), "utf8"));
    const claims = JSON.parse(Buffer.from(String(parsed.tokens?.access_token || "").split(".")[1] || "", "base64url").toString("utf8"));
    const plan = String(claims["https://api.openai.com/auth"]?.chatgpt_plan_type || "").toLowerCase();
    if (plan !== "enterprise") return { ...state, authenticated: false, detail: `the dedicated login does not identify an Enterprise workspace; ${remedy}` };
  } catch {
    return { ...state, authenticated: false, detail: `the dedicated Enterprise login could not be verified; ${remedy}` };
  }
  return state;
}

export function makeCodexEuAdapter(base) {
  return validateEngineAdapter({
    ...base,
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
