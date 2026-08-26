// Shared shape-cleaners for the admin resource routers (settings / channels / dms). Split out
// of admin.js so each resource module can import exactly what it validates with; behavior is
// unchanged.
import { sanitizeMcpMatch, sanitizeCodexMcpSelection } from "../security.js";
import { ENGINES } from "../../config/settings.js";
import { isValidModel } from "../../slack/util.js";
import { sanitizeSkillGrantNames } from "../../gateway/access-grants.js";

// Model/effort validation shared by the channel-meta, DM, and DM-template routes: an arbitrary
// string stored here goes straight to the engine's --model/--effort flags and breaks every later
// turn in the channel — same guard as the Slack /model command (isValidModel).
const EFFORTS = ["", "none", "low", "medium", "high", "xhigh", "max"]; // mirrors the admin UI select
export function invalidModelOrEffort(body) {
  if (typeof body.model === "string" && body.model.trim() && !isValidModel(body.model)) return `unrecognized model "${body.model.trim()}"`;
  if (typeof body.effort === "string" && !EFFORTS.includes(body.effort.trim())) return `effort must be one of: ${EFFORTS.filter(Boolean).join(", ")} (or empty)`;
  return "";
}

// allowedMcps entries feed the channel lockdown, so each field is shape-checked — `match` in
// particular (via sanitizeMcpMatch) since it becomes an allowedMcpServers matcher; entries
// with an unrecognized match are dropped.
export const sanitizeMcps = (arr) =>
  Array.isArray(arr)
    ? arr
        .map((m) => (m && m.name && m.namespace ? { name: String(m.name), match: sanitizeMcpMatch(m.match), namespace: String(m.namespace) } : null))
        .filter((m) => m && m.match)
    : [];
export const sanitizeCodexMcps = (arr) =>
  Array.isArray(arr) ? arr.map(sanitizeCodexMcpSelection).filter(Boolean) : [];

export const cleanAccessGrants = (value) => ({
  skills: sanitizeSkillGrantNames(value?.skills),
  allowedMcps: sanitizeMcps(value?.allowedMcps),
  allowedCodexMcps: sanitizeCodexMcps(value?.allowedCodexMcps),
  // OpenCode currently rejects all MCP capability at admission. Preserve no selections here so a
  // hand-written setting cannot silently broaden its restricted proof profile.
  allowedOpenCodeMcps: [],
});

// Shape-clean one DM template (User/Admin) before persisting. Its model/effort are validated by the
// caller via invalidModelOrEffort; here we only coerce types and drop unknown engines/MCP matches.
// Used by the settings PUT — the templates live under Settings → Access Templates.
export const cleanDmTemplate = (t) => ({
  skills: Array.isArray(t?.skills) ? t.skills : [],
  allowedMcps: sanitizeMcps(t?.allowedMcps),
  allowedCodexMcps: sanitizeCodexMcps(t?.allowedCodexMcps),
  model: typeof t?.model === "string" ? t.model.trim() : "",
  effort: typeof t?.effort === "string" ? t.effort.trim() : "",
  adminMode: Boolean(t?.adminMode),
  allowBash: Boolean(t?.allowBash),
  allowNetwork: Boolean(t?.allowNetwork),
  autoMode: Boolean(t?.autoMode),
  cleanMode: Boolean(t?.cleanMode),
  engine: ENGINES.includes(t?.engine) ? t.engine : "",
});
