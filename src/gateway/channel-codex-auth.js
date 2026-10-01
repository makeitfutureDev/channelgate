// A channel can select a separate host-side Codex login. The directory is keyed by the stable
// conversation ID, not by its display name or agent-writable work folder. Only the daemon reads
// auth.json; container turns receive a proxy placeholder instead.
import { createHash } from "node:crypto";
import path from "node:path";
import { gatewayRoot } from "../config/paths.js";
import { buildChildEnv } from "../engines/child-env.js";

export const CODEX_AUTH_SOURCES = Object.freeze(["gateway", "channel"]);

export function channelCodexHome(channelId) {
  const id = String(channelId || "");
  if (!id) return "";
  const key = createHash("sha256").update(id).digest("hex").slice(0, 24);
  return path.join(gatewayRoot(), "engine-state", "codex-channels", key);
}

export function codexAuthProcessEnv(home) {
  const env = buildChildEnv({ CODEX_HOME: home, HOME: path.dirname(home) });
  // The selected CODEX_HOME alone supplies credentials and app configuration. Never inherit
  // another service login or XDG config tree into a channel's discovery or sign-in process.
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "SSH_AUTH_SOCK"]) delete env[key];
  return env;
}

export function codexLoginCandidatesFor(meta, fallback = null) {
  if (meta?.codexAuthSource !== "channel") return fallback;
  const home = channelCodexHome(meta.channelId);
  return home ? [path.join(home, "auth.json")] : [];
}
