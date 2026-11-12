// Dedicated Codex credential selection. A saved channel account must never silently fall
// back to the gateway account when its Enterprise entitlement is unavailable.
import path from "node:path";
import { requireEnterpriseFeature } from "../ee/feature-entitlements.js";
import { channelCodexHome, codexEuLoginHome, isCodexEu } from "./channel-codex-paths.js";
export { CODEX_AUTH_SOURCES, channelCodexHome, codexAuthProcessEnv } from "./channel-codex-paths.js";

export function codexLoginCandidatesFor(meta, fallback = null) {
  if (isCodexEu(meta)) return [path.join(codexEuLoginHome(), "auth.json")];
  if (meta?.codexAuthSource !== "channel") return fallback;
  requireEnterpriseFeature("channelCodexLogin");
  const home = channelCodexHome(meta.channelId);
  return home ? [path.join(home, "auth.json")] : [];
}
