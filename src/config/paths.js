// Resolves paths. The hidden runtime root (~/.channelgate/) holds config, per-channel metadata,
// sessions, and logs. Channel WORKING folders ("discussions") live under the visible workspace
// root (~/ChannelGate/<platform>/) — see workspaceRoot() / workspaceFolder().
//
// Both roots were renamed with the product (formerly ~/.claude-gateway and ~/Slack Agent) and the
// per-channel folders gained a platform component. scripts/migrate-channelgate.mjs moves an
// existing install; the legacy env names below keep a machine that still exports them working.
import os from "node:os";
import path from "node:path";
import { platformFolderName } from "../platforms/registry.js";

// The pre-rename env names, honoured for one major so an operator's exported shell profile, a
// stale systemd unit, or an old plist does not silently point the daemon at a brand-new empty
// root. Warned about ONCE per process — this is read on nearly every path lookup.
const LEGACY_ENV = Object.freeze({ CHANNELGATE_DIR: "CLAUDE_GATEWAY_DIR", CHANNELGATE_DB: "CLAUDE_GATEWAY_DB" });
const warnedLegacyEnv = new Set();
export function readRootEnv(name, env = process.env) {
  const current = env[name];
  if (current) return current;
  const legacyName = LEGACY_ENV[name];
  const legacy = legacyName ? env[legacyName] : "";
  if (!legacy) return "";
  if (!warnedLegacyEnv.has(legacyName)) {
    warnedLegacyEnv.add(legacyName);
    console.warn(`[paths] ${legacyName} is deprecated — rename it to ${name}. Honoured for now; support is removed in the next major.`);
  }
  return legacy;
}
// Test seam: the once-per-process warning would otherwise fire in whichever test ran first.
export function resetLegacyEnvWarnings() {
  warnedLegacyEnv.clear();
}

export function gatewayRoot() {
  const dir = readRootEnv("CHANNELGATE_DIR");
  return dir ? path.resolve(dir) : path.join(os.homedir(), ".channelgate");
}

export function configDir() {
  return path.join(gatewayRoot(), "config");
}
// Single SQLite database file for all operational data (users, channels, meta, sessions,
// schedules, acks, followups, background jobs, usage ledger, event logs). Config that stays
// as JSON (settings.json, mcp-catalog.json, per-channel .claude/settings.json) is NOT here.
export function dbFile() {
  const file = readRootEnv("CHANNELGATE_DB");
  return file ? path.resolve(file) : path.join(gatewayRoot(), "gateway.db");
}
export function channelsDir() {
  return path.join(gatewayRoot(), "channels");
}
export function logsDir() {
  return path.join(gatewayRoot(), "logs");
}
// Short-lived per-run files that carry credentials (the Claude --mcp-config payload embeds the
// author's Composio/Skills/Toolbox tokens). Deliberately under the gateway root rather than the
// OS tmpdir: every channel's sandbox read-denies this root, while the shared tmpdir is readable
// by any same-user process — including another channel's agent, which auto-approves Read.
export function runTmpDir() {
  return path.join(gatewayRoot(), "run-tmp");
}
// The synthetic HOME every `claude` subprocess runs under. It lives INSIDE the gateway root,
// which the channel sandbox read-denies wholesale — so anything the run needs to reach through
// this HOME (the git/gh credential symlinks planted by run-grant-artifacts) must be re-allowed
// by path, not just at its real target. One helper so the planter and the sandbox builder can
// never drift onto different directories.
export function claudeEngineHome() {
  return path.join(gatewayRoot(), "engine-state", "claude", "home");
}
// The stable CODEX_HOME every `codex` subprocess runs with — auth + rollout state only, kept
// OUTSIDE the per-run grant root because Codex persists the rollout pathname in its thread index
// (see run-grant-artifacts.stableCodexState). Same one-helper rule as claudeEngineHome(): the
// link planter, the auth probe, and the health check must never drift onto different directories.
export function codexEngineHome() {
  return path.join(gatewayRoot(), "engine-state", "codex", "home", ".codex");
}
export function updateStateFile() {
  return path.join(gatewayRoot(), "update-state.json");
}
export function updateLockFile() {
  return path.join(gatewayRoot(), "update.lock");
}
export function updateMarkerFile() {
  return path.join(gatewayRoot(), "update-pending.json");
}
export function updateBackupsDir() {
  return path.join(gatewayRoot(), "update-backups");
}

export const WHISPER_CPP_VERSION = "v1.9.1";
export const WHISPER_MODEL_NAME = "ggml-large-v3-turbo.bin";
export function whisperToolsDir() {
  return path.join(gatewayRoot(), "tools", "whisper", WHISPER_CPP_VERSION);
}
export function whisperCliPath() {
  return process.env.WHISPER_CLI_PATH
    ? path.resolve(process.env.WHISPER_CLI_PATH)
    : path.join(whisperToolsDir(), "bin", "whisper-cli");
}
export function whisperModelPath() {
  return process.env.WHISPER_MODEL_PATH
    ? path.resolve(process.env.WHISPER_MODEL_PATH)
    : path.join(gatewayRoot(), "models", "whisper", WHISPER_MODEL_NAME);
}

// Visible workspace root where each channel's working folder ("discussion") lives — separate
// from the hidden runtime root (which keeps config, per-channel metadata, sessions, logs).
// Default: ~/ChannelGate. Override with CG_WORKSPACE_DIR.
export function workspaceRoot() {
  return process.env.CG_WORKSPACE_DIR
    ? path.resolve(process.env.CG_WORKSPACE_DIR)
    : path.join(os.homedir(), "ChannelGate");
}
// Every per-channel folder is namespaced by the channel's chat surface, so one workspace can hold
// a Slack #ops and a Teams "Ops" without either shadowing the other, and an operator browsing
// ~/ChannelGate can see which surface a folder belongs to. The component comes from the platform
// registry's `folderName` fact — never from a switch here — and an unknown/missing platform
// resolves to Slack (every row written before multi-platform support is a Slack row).
export function platformFolder(platform) {
  return platformFolderName(platform);
}
export function workspaceFolder(slug, platform) {
  return path.join(workspaceRoot(), platformFolder(platform), slug);
}
// Clean-mode runs get a bare workspace under the runtime root, namespaced the same way.
export function cleanWorkspaceFolder(slug, platform) {
  return path.join(gatewayRoot(), "clean-workspaces", platformFolder(platform), slug);
}

export function usersFile() {
  return path.join(configDir(), "users.json");
}
export function channelsIndexFile() {
  return path.join(configDir(), "channels.json");
}
export function mcpCatalogFile() {
  return path.join(configDir(), "mcp-catalog.json");
}
export function settingsFile() {
  return path.join(configDir(), "settings.json");
}

// A single conversation's gated folder + its files. Same platform namespacing as the visible
// workspace: <runtime root>/channels/<platform>/<slug>.
export function channelFolder(slug, platform) {
  return path.join(channelsDir(), platformFolder(platform), slug);
}
export function channelMetaFile(slug, platform) {
  return path.join(channelFolder(slug, platform), "meta.json");
}
export function channelSessionsFile(slug, platform) {
  return path.join(channelFolder(slug, platform), "sessions.json");
}
export function channelSettingsFile(slug, platform) {
  return path.join(channelFolder(slug, platform), ".claude", "settings.json");
}
// Admin-run variant of the lockdown file: identical settings except it allows the
// --dangerously-skip-permissions bypass. Written only while the channel is in admin mode and
// passed via --settings solely for admin-author runs (see folders.js/run.js) — the shared
// settings.json above never carries the bypass allowance.
export function channelAdminSettingsFile(slug, platform) {
  return path.join(channelFolder(slug, platform), ".claude", "settings-admin.json");
}
export function channelSkillsDir(slug, platform) {
  return path.join(channelFolder(slug, platform), ".claude", "skills");
}

// Turn a Slack channel name / id into a filesystem-safe, human-readable folder slug.
// Channels keep a readable name (e.g. "#team-ops" → "team-ops"); DMs/unknown
// names fall back to the id so the folder is always stable and collision-free.
// The result MUST be a single safe path component — it's joined under channelsDir()/
// workspaceRoot() — so path separators are squashed and leading/trailing dots are stripped
// (which also rejects "." / ".." outright: a crafted DM display name must never resolve
// outside the channels root). Anything left empty falls back to the sanitized id.
export function slugify(name, fallbackId) {
  const clean = (s) =>
    String(s ?? "")
      .trim()
      .toLowerCase()
      .replace(/^[#@]/, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "");
  const base = clean(name);
  if (base) return base;
  return `id-${clean(fallbackId) || "unknown"}`;
}
