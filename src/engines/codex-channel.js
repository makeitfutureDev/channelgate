// The channel's customer account is an explicit harness, independent of the gateway login.
import { validateEngineAdapter, commandHealth } from "./contract.js";
import { preserveChannelCodexHistory } from "./codex-channel-history.js";
import { readCodexAuthState } from "./codex-auth.js";
import { channelCodexHome } from "../gateway/channel-codex-paths.js";

export async function channelCodexCredentialState({ channelId = "", ...options } = {}) {
  const home = channelCodexHome(channelId);
  if (!home) return { known: true, authenticated: false, detail: "select a channel with a connected Codex account" };
  return readCodexAuthState({ ...options, codexHome: home, hostCodexHome: home, env: {} });
}

export function makeChannelCodexAdapter(base) {
  return validateEngineAdapter({
    ...base,
    id: "codex-channel", label: "Codex (channel account)", modelFamily: "codex", channelScoped: true, enabledWith: base.id,
    // Defaults share the model catalog, but optional MCP selections belong to this account.
    mcpMetaKey: "allowedChannelCodexMcps",
    supports: { ...base.supports, usageLimitFallback: false },
    subscriptionUsage: undefined,
    updateSmoke: undefined,
    discoverModels: base.discoverModels,
    discoverMcps: options => options?.channelId ? base.discoverMcps(options) : Promise.resolve([]),
    credentialState: undefined,
    sessionState: { ...base.sessionState, channelHistory: false, containerDirKey: "codexChannelHome",
      hostDir: ({ channelId = "" } = {}) => channelCodexHome(channelId) },
    resumeCommand(id, { target = null } = {}) {
      const home = target?.backend === "container" || target?.runtime?.capabilities?.isolated
        ? target?.container?.codexChannelHome || `${target?.container?.home || "/home/agent"}/.codex-channel`
        : channelCodexHome(target?.meta?.channelId);
      if (!home) throw new Error("Codex (channel account) resume requires its channel runtime target");
      const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
      return `env CODEX_HOME=${quote(home)} codex exec resume ${quote(id)}`;
    },
    async selectionReadiness({ channelId = "", meta } = {}) {
      const { enterpriseFeatureEnabled } = await import("../ee/feature-entitlements.js");
      if (!enterpriseFeatureEnabled("channelCodexLogin")) return { ready: false, reason: "an active Enterprise license is required for channel Codex accounts" };
      if (!meta && channelId) {
        const { getChannelEntry, getChannelMeta } = await import("../config/store.js");
        const entry = await getChannelEntry(channelId);
        meta = entry ? await getChannelMeta(entry.slug) : null;
      }
      if (meta?.codexAuthSource !== "channel") return { ready: false, reason: "connect this channel’s Codex account in channel Settings" };
      const auth = await channelCodexCredentialState({ channelId: channelId || meta?.channelId });
      return { ready: auth.authenticated === true, reason: "connect this channel's Codex account in channel Settings" };
    },
    async health(options) {
      const cli = await commandHealth("codex", options);
      return { ...cli, auth: { known: false, authenticated: false, detail: "Sign-in is scoped to each channel; connect an account in channel Settings." } };
    },
    async run(ctx) {
      const { requireEnterpriseFeature } = await import("../ee/feature-entitlements.js");
      requireEnterpriseFeature("channelCodexLogin");
      const target = ctx.target;
      const channelId = target?.meta?.channelId || "";
      const auth = await channelCodexCredentialState({ channelId });
      if (target?.meta?.codexAuthSource !== "channel" || !auth.authenticated) throw Object.assign(new Error("Codex (channel account) is not connected. Connect it in this channel's Settings."), {
        details: { engine: this.id, providerKind: "authentication", providerError: true, replaySafe: true, toolUseCount: 0 },
      });
      const selected = { ...target, meta: { ...target?.meta, engine: this.id, codexHarness: "", codexAuthSource: "channel" },
        ...(target?.container ? { container: { ...target.container, codexHome: target.container.codexChannelHome || `${target.container.home || "/home/agent"}/.codex-channel` } } : {}) };
      try {
        await preserveChannelCodexHistory({ ...ctx, target: selected });
        return await base.run.call(this, { ...ctx, target: selected,
          runtime: { ...ctx.runtime, codexStateDir: target?.backend === "container" ? "" : channelCodexHome(channelId) } });
      } catch (error) {
        if (error?.details) error.details = { ...error.details, engine: this.id };
        throw error;
      }
    },
  });
}
