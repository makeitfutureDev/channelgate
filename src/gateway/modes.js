import { adapterFor } from "../engines/registry.js";
import { NETWORK_ADVISORY_NOTE, NETWORK_POLICY_ENFORCED } from "../engines/network-policy.js";

// A channel's capability "mode" is a friendly name over the underlying flags (adminMode,
// allowBash, autoMode). One mode = one canonical flag combination. `allowNetwork` is orthogonal
// (shown alongside, set with its own toggle), so /mode doesn't touch it.
//
//   read  — read-only tools; anything else asks for approval (buttons)
//   bash  — Bash + file writes inside the channel's container
//   auto  — autonomous: prompts auto-approved
//   admin — full tools, permission prompts bypassed (admin authors only); the container is still
//           the boundary, and the work folder is what it sees of the host

export const MODE_FLAGS = {
  read: { adminMode: false, allowBash: false, autoMode: false },
  bash: { adminMode: false, allowBash: true, autoMode: false },
  auto: { adminMode: false, allowBash: false, autoMode: true },
  admin: { adminMode: true, allowBash: false, autoMode: false },
};
export const MODES = Object.keys(MODE_FLAGS);

const LABELS = { read: "Read-only", bash: "Bash", auto: "Auto", admin: "Admin" };

// The effective mode for a meta (highest capability wins).
export function channelMode(meta = {}) {
  if (meta.adminMode) return "admin";
  if (meta.autoMode) return "auto";
  if (meta.allowBash) return "bash";
  return "read";
}

// The channel's Allow-network switch as one of three honest words. "off" is a real state and must
// be SAID: the old label appended a suffix only when the switch was on, so every surface rendered
// "off" and "nobody ever configured it" identically — the one thing an operator (or the engine)
// cannot afford to guess about the network.
export function networkState(meta = {}) {
  if (!meta.allowNetwork) return "off";
  const engine = String(meta.engine || "claude");
  return (adapterFor(engine)?.supports?.networkModes || []).includes("on") ? "on" : "unsupported";
}

// `detail` adds the honest caveat for the OFF state: under the container runtime the switch is
// advisory (see engines/network-policy.js), so "off" is an instruction the engines are given, not
// a wall that stops them. Compact by default — this rides the channel list — and detailed where
// someone is actually asking about the setting (`/mode`, `/status`).
export function networkLabel(meta = {}, { detail = false } = {}) {
  const state = networkState(meta);
  if (state === "off" && detail && !NETWORK_POLICY_ENFORCED) return `network off (${NETWORK_ADVISORY_NOTE})`;
  return `network ${state}`;
}

export function modeLabel(meta = {}, opts = {}) {
  return `${LABELS[channelMode(meta)]} · ${networkLabel(meta, opts)}`;
}

// ── Capability profiles ───────────────────────────────────────────────────────
// A profile is a friendly preset that expands to a canonical bundle of the flags above — one
// dropdown instead of a grid of toggles. "custom" is the escape hatch: the stored flags are used
// verbatim (the UI unlocks every checkbox). The clean/network toggles stay orthogonal: a preset
// sets the four capability flags (adminMode/allowBash/autoMode/cleanMode); network is separate.
//
//   read   — read-only tools; anything riskier asks for approval (safest, default)
//   worker — Bash + file writes in the channel's container; still asks before unusual actions
//   auto   — autonomous: like worker but auto-approves and keeps going
//   full   — every tool, no permission prompts (only honored for an admin author; else falls back)
//   lean   — bare model: no MCP servers, no skills, no favorites block (cheapest/fastest)
export const PROFILE_FLAGS = {
  read: { adminMode: false, allowBash: false, autoMode: false, cleanMode: false },
  worker: { adminMode: false, allowBash: true, autoMode: false, cleanMode: false },
  auto: { adminMode: false, allowBash: true, autoMode: true, cleanMode: false },
  full: { adminMode: true, allowBash: false, autoMode: false, cleanMode: false },
  lean: { adminMode: false, allowBash: false, autoMode: false, cleanMode: true },
};
export const PROFILES = [...Object.keys(PROFILE_FLAGS), "custom"];

export const PROFILE_LABELS = {
  read: "Read-only",
  worker: "Worker",
  auto: "Autonomous",
  full: "Full access",
  lean: "Lean",
  custom: "Custom…",
};

// Example/help text shown under the dropdown, one line per profile (UI + /mode help).
export const PROFILE_HELP = {
  read: "Answers and reads files in this channel's folder. Can't edit or run commands; anything riskier asks you to approve. Safest.",
  worker: "Runs commands and edits files inside this channel's container. Still asks before unusual actions. For channels that build things.",
  auto: "Like Worker but doesn't stop to ask — auto-approves and keeps going. For trusted, multi-step tasks.",
  full: "Every tool, no permission prompts. Only works when an org admin sends the message; otherwise falls back to Worker behaviour. The channel container is still the boundary. Use only for trusted ops channels.",
  lean: "Bare model — no skills or connectors. Cheapest and fastest, but can't use HubSpot/Gmail/etc.",
  custom: "Set every capability yourself (mode, network, clean).",
};

// The profile a meta represents: an explicit stored `profile` (when valid) wins so a deliberate
// "Custom" survives even if its flags happen to equal a preset; otherwise derive it from the flags
// so legacy channels (saved before profiles existed) map to the right preset with no migration.
export function channelProfile(meta = {}) {
  if (meta.profile && PROFILES.includes(meta.profile)) return meta.profile;
  if (meta.cleanMode) return "lean";
  if (meta.adminMode) return "full";
  if (meta.autoMode) return "auto";
  if (meta.allowBash) return "worker";
  return "read";
}

// ── Who may talk ──────────────────────────────────────────────────────────────
// Authorization model (moved here from slack/app.js so it sits beside canManage — "who may talk"
// and "who may change settings" in one place):
//  - An explicit per-channel grant (meta.allowedUsers) always allows — the manual override, and the
//    escape hatch for an otherwise-restricted channel. Never applies to DMs.
//  - DMs: admins + approved users only (the channel access policy is channel-scoped).
//  - Channels honor the channel's access policy (meta.access, captured from the gateway default at
//    join; missing = "approved" for back-compat):
//      "approved" → admins + approved users   ·   "admins" → admins only   ·   "none" → nobody
//    ("none" is dormant: only the explicit allowedUsers grant above gets in — even admins must be
//    added there.)
export function isAuthorized(meta, authorId, isDM, { isAdminUser = false, isApprovedUser = false } = {}) {
  if (!isDM && Array.isArray(meta.allowedUsers) && meta.allowedUsers.includes(authorId)) return true;
  if (isDM) return isAdminUser || isApprovedUser;
  const access = meta.access || "approved";
  if (access === "none") return false;
  if (access === "admins") return isAdminUser;
  return isAdminUser || isApprovedUser;
}

// ── Who can manage a channel ──────────────────────────────────────────────────
// "Manage" = change this channel's SAFE settings (capability profile up to Autonomous, skills,
// connectors) from inside Slack. Governed by meta.manageAccess (default "admins"), so existing
// channels are unchanged and relaxing it is strictly opt-in per channel:
//   - "admins"  → gateway admins only (default)
//   - "members" → any approved member (membership is implied by posting in the channel)
//   - "custom"  → only the users listed in meta.managers[]
// The DANGEROUS escalations (Full-access / network / work-dir) are NEVER delegated here — the call
// sites keep requiring an admin author for those. This function only answers "safe-manage?".
export function canManage(meta = {}, { authorId = "", isAdminUser = false, isApprovedUser = false } = {}) {
  if (isAdminUser) return true;
  const mode = meta.manageAccess || "admins";
  if (mode === "members") return Boolean(isApprovedUser);
  if (mode === "custom") return Array.isArray(meta.managers) && meta.managers.includes(authorId);
  return false;
}
