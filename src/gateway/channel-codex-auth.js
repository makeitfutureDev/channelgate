// Dedicated Codex credential selection. A saved channel account must never silently fall
// back to the gateway account when its Enterprise entitlement is unavailable.
import path from "node:path";
import { requireEnterpriseFeature } from "../ee/feature-entitlements.js";
import { channelCodexHome, dedicatedCodexLogin, isChannelCodex } from "./channel-codex-paths.js";
export { CODEX_AUTH_SOURCES, channelCodexHome, codexAuthProcessEnv } from "./channel-codex-paths.js";

export function codexLoginCandidatesFor(meta, fallback = null) {
  // A dedicated login (Codex EU, or a Codex license) reads its own directory and nothing else.
  const dedicated = dedicatedCodexLogin(meta);
  if (dedicated) return [path.join(dedicated.home, "auth.json")];
  if (!isChannelCodex(meta)) return fallback;
  requireEnterpriseFeature("channelCodexLogin");
  const home = channelCodexHome(meta.channelId);
  return home ? [path.join(home, "auth.json")] : [];
}
