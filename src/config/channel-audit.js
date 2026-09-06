// The audit trail for a channel's POLICY — one home for "what changed, and how is it written down?".
//
// A channel's meta record IS its security posture: Allow-network, Full access (adminMode), auto
// mode, shell, the working folder, who may use and who may manage the conversation, its MCP
// allowlist, its engine/model. Until now those could be flipped from the admin UI (PUT
// /api/channels/:channelId/meta) or from chat (the set_channel_* MCP tools) and leave NO row in
// `events` at all — the per-channel environment secrets were audited, the posture that decides what
// a run can reach was not. An operator asking "who turned the network on for this channel, and
// when?" had nothing to read.
//
// Both surfaces now diff the record they were about to save against the one they replaced and emit
// a single `channel_meta_changed` event carrying only the keys that actually changed, with their
// before/after values.
//
// Two rules the allowlist below enforces by construction:
//   • Only POLICY keys are diffed. Secrets (composioToken, toolboxToken, makeToolboxKey, the `env`
//     bag) are not on the list and can therefore never reach an audit row, whatever a caller passes.
//     Environment secrets keep their own name-only audit (channel_env_set/_removed).
//   • `skills` is reported as a COUNT, never as the list — the grant list is long, noisy, and the
//     skills surface has its own audit (skill_granted/skill_revoked).
import { logEvent } from "../util/logger.js";

// The admin web UI authenticates ONE shared admin password and its sessions carry no personal
// identity (src/web/auth.js: token → timestamps, nothing more), so a change made there is
// attributed to the surface rather than to a person. Say that plainly rather than inventing a name.
// Same string the skills routes have always written, so the whole audit reads with one spelling.
// (The older per-channel env audit in web/routes/channels.js still spells it "admin UI".)
export const ADMIN_UI_ACTOR = "admin-ui";

// The curated policy allowlist. Order is the reporting order.
export const POLICY_KEYS = Object.freeze([
  "profile", // capability preset (read|worker|auto|full|lean|custom)
  "adminMode", // Full access: no sandbox, no prompts, for admin authors
  "autoMode", // permission prompts auto-approved
  "allowBash", // shell + file-edit tools
  "allowNetwork", // network egress for the channel's runs
  "cleanMode", // run bare (no MCP servers, no skills)
  "noDefaultTokens", // refuse the org-default token fallback here
  "engine", // per-channel engine override
  "model",
  "effort",
  "runtime", // where a turn runs, when a channel pins it
  "workDir", // the folder every run in this channel reads and writes
  "syncDriveFolder", // the Drive folder two-way-synced into that folder
  "access", // who may USE the conversation
  "manageAccess", // who may MANAGE it
  "managers",
  "allowedUsers",
  "allowedMcps",
  "allowedCodexMcps",
  "template", // DM org template (user|admin|custom)
  "skillTemplate", // the skill template this conversation follows
  "skills", // counts only — never the grant list
]);

// Keys whose value is a list. Reported as a sorted array of plain strings so a reordered list is
// not a "change" and an MCP selection object never drags its transport/config fields into the row.
const LIST_KEYS = new Set(["managers", "allowedUsers", "allowedMcps", "allowedCodexMcps"]);

// A whole row's `changes` blob stays bounded: a 400-member allowedUsers list must not turn one
// audit event into a document. Over the cap, list values collapse to their counts.
const MAX_CHANGES_BYTES = 8000;

function listValue(key, value) {
  if (!Array.isArray(value)) return [];
  const names = value.map((entry) => {
    if (entry && typeof entry === "object") return String(entry.name ?? entry.id ?? "");
    return String(entry ?? "");
  });
  return names.filter(Boolean).sort();
}

// Reduce one stored value to the shape the audit records. Unknown/absent → null, so a key that
// appears for the first time reads as null → value rather than vanishing from the diff.
function shape(key, value) {
  if (key === "skills") return Array.isArray(value) ? value.length : 0;
  if (LIST_KEYS.has(key)) return listValue(key, value);
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value;
  return String(value);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The POLICY difference between two channel meta records: `{ key: { from, to } }` for every
 * allowlisted key whose value actually changed, and nothing for the rest. Pure — no I/O, no logging
 * — so both the admin API and the MCP tools can diff the same way and a test can assert on it
 * directly.
 */
export function policyDiff(before, after) {
  const changes = {};
  for (const key of POLICY_KEYS) {
    const from = shape(key, before?.[key]);
    const to = shape(key, after?.[key]);
    // `skills` REPORTS a count, but the change is DETECTED on the list: swapping one grant for
    // another changes what every future run here loads, and a count comparison would call that no
    // change at all. The slug-level trail is the skills audit's own (skill_granted/skill_revoked).
    const changed = key === "skills" ? !same(listValue(key, before?.[key]), listValue(key, after?.[key])) : !same(from, to);
    if (!changed) continue;
    changes[key] = { from, to };
  }
  if (JSON.stringify(changes).length > MAX_CHANGES_BYTES) {
    for (const [key, change] of Object.entries(changes)) {
      if (!Array.isArray(change.from) && !Array.isArray(change.to)) continue;
      changes[key] = {
        fromCount: Array.isArray(change.from) ? change.from.length : 0,
        toCount: Array.isArray(change.to) ? change.to.length : 0,
        truncated: true,
      };
    }
  }
  return changes;
}

/**
 * Write the audit row for one successful channel-policy mutation. Call it AFTER the save committed,
 * with the record that was replaced and the record that is now stored.
 *
 * `actor` is the principal that made the change: ADMIN_UI_ACTOR for the admin API (one shared
 * password, no personal identity) or the chat author's user id for an MCP tool. It is written to
 * BOTH `actor` and the event's `author` column — an admin-UI row that left `author` empty read as
 * unattributed, and "admin-ui" in that column is exactly what the skills audit already writes.
 *
 * Returns the changes it logged, or null when nothing on the policy allowlist moved — an unrelated
 * save (a nudge toggle, an environment variable, a memory edit) writes no row at all.
 */
export async function logChannelPolicyChange({ channelId = "", slug = "", actor = "", before, after, source = "" } = {}) {
  const changes = policyDiff(before, after);
  const keys = Object.keys(changes);
  if (!keys.length) return null;
  const who = String(actor || ADMIN_UI_ACTOR);
  await logEvent("channel_meta_changed", {
    channel: channelId,
    slug,
    author: who,
    actor: who,
    source: source || (who === ADMIN_UI_ACTOR ? "admin-ui" : "mcp"),
    keys,
    changes,
  });
  return changes;
}
