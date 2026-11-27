// Dependency-free Codex login paths and sanitized CLI environment. Engine adapters import this
// leaf without pulling license/settings back into their registry initialization.
import { createHash } from "node:crypto";
import path from "node:path";
import { gatewayRoot } from "../config/paths.js";
import { buildChildEnv } from "../engines/child-env.js";
import { licenseKindOfId, licenseLoginCommand, licenseLoginHome, licenseRecord } from "../engines/license-state.js";

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


// Optional ChatGPT harness: one dedicated login, never the daemon or channel account.
export function codexEuLoginHome() {
  return path.join(gatewayRoot(), "engine-state", "codex-eu-login");
}

export function isChannelCodex(meta) {
  return meta?.engine === "codex-channel";
}

export function isCodexEu(meta) {
  return meta?.codexHarness === "eu" || meta?.engine === "codex-eu";
}

export function codexEuLoginHint() {
  const quoted = `'${codexEuLoginHome().replaceAll("'", "'\\''")}'`;
  return `install -d -m 700 ${quoted} && CODEX_HOME=${quoted} codex -c 'cli_auth_credentials_store="file"' login --device-auth`;
}

// ── Dedicated ChatGPT logins ──────────────────────────────────────────────────────────────────
// Codex EU was the first isolated ChatGPT login; a Codex LICENSE an administrator adds
// (engines/license-state.js) is the same thing, one per license. Everything that must treat such a
// run differently from the gateway's own Codex login — its CODEX_HOME, its file credential store,
// its relay placeholder, the API-key environment it must never inherit — asks here, so a license
// is not a second set of branches. `codexHarness` on a run's meta names the login the target was
// resolved for ("eu" or "license:<id>"); a meta without one falls back to its engine id.
const LICENSE_HARNESS_PREFIX = "license:";
export const codexHarnessFor = (engine) => engine === "codex-eu" ? "eu" : licenseKindOfId(engine)?.id === "codex-login" ? `${LICENSE_HARNESS_PREFIX}${engine}` : "";

// → null, or { kind: "eu" | "license", id, label, home, loginHint }.
export function dedicatedCodexLogin(meta) {
  const harness = String(meta?.codexHarness || "");
  const engine = String(meta?.engine || "");
  const licenseId = harness.startsWith(LICENSE_HARNESS_PREFIX) ? harness.slice(LICENSE_HARNESS_PREFIX.length) : !harness ? engine : "";
  if (licenseKindOfId(licenseId)?.id === "codex-login") {
    const record = licenseRecord(licenseId);
    return {
      kind: "license", id: licenseId, label: record?.label || "This Codex license", home: licenseLoginHome(licenseId),
      // A license deleted while a turn was already resolved has no login to name a remedy for.
      loginHint: record ? licenseLoginCommand(record) : "", exists: Boolean(record),
    };
  }
  if (isCodexEu(meta)) return { kind: "eu", id: "codex-eu", label: "Codex EU", home: codexEuLoginHome(), loginHint: codexEuLoginHint(), exists: true };
  return null;
}
export const isDedicatedCodex = (meta) => Boolean(dedicatedCodexLogin(meta));
