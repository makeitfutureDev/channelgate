// A channel can select a separate host-side Codex login. The directory is keyed by the stable
// conversation ID, not by its display name or agent-writable work folder. Only the daemon reads
// auth.json; container turns receive a proxy placeholder instead.
import { createHash } from "node:crypto";
import path from "node:path";
import { gatewayRoot } from "../config/paths.js";

export const CODEX_AUTH_SOURCES = Object.freeze(["gateway", "channel"]);

export function channelCodexHome(channelId) {
  const id = String(channelId || "");
  if (!id) return "";
  const key = createHash("sha256").update(id).digest("hex").slice(0, 24);
  return path.join(gatewayRoot(), "engine-state", "codex-channels", key);
}

export function codexLoginCandidatesFor(meta, fallback = null) {
  if (meta?.codexAuthSource !== "channel") return fallback;
  const home = channelCodexHome(meta.channelId);
  return home ? [path.join(home, "auth.json")] : [];
}
