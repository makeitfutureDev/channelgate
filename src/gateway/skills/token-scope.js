// What a /mcp/skills access token may reach, resolved per request (skills/tokens.js explains the
// two kinds).
//
//   catalog — the library: every organization and channel skill the catalog holds; personal skills
//             do not exist for it (not listed, not readable, not exportable, not editable) and its
//             `manage` scope writes organization and channel library skills only.
//   user    — the person who minted it, computed LIVE from the stores on every call: their current
//             rank (an admin sees and edits what an admin does; a person who is no longer approved
//             has a dead token), the channels whose access policy admits them right now (each
//             channel's own grants, its template and its section skills), the organization grants
//             and the discoverable library, and their own personal skills. Writes follow the chat
//             rules (src/mcp/tools/skills.js): a personal skill is its author's, a channel skill is
//             its members', the organization tier is an admin's.
import { getUser, isAdmin, isApproved, listChannels } from "../../config/store.js";
import { getOrgAccessGrants } from "../../config/settings.js";
import { isAuthorized } from "../modes.js";
import { sanitizeSkillGrantNames } from "../access-grants.js";
import { withTemplateSkills, channelScopedSkills } from "./templates.js";
import { skillTier } from "./authoring.js";

const lower = (s) => String(s || "").toLowerCase();

export function catalogTokenScope(token) {
  return {
    kind: "catalog",
    token,
    ownerId: "",
    admin: false,
    viewer: "",
    // The library: anything that is not personal. `read` keeps the discoverable rule the catalog
    // endpoint always had; `sync` sees non-discoverable library skills too (they are library content).
    canRead: (skill) => Boolean(skill) && !skill.deleted && skill.visibility !== "personal" && Boolean(skill.discoverable),
    canExport: (skill) => Boolean(skill) && !skill.deleted && skill.visibility !== "personal",
    canManage: (skill) => Boolean(skill) && !skill.deleted && skill.visibility !== "personal",
    createOptions: () => ({ personal: false, channelId: "" }),
    reason: "",
  };
}

// null when the owner can no longer use the catalog (unknown, unapproved, or not an admin).
export async function userTokenScope(token) {
  const ownerId = String(token?.ownerId || "");
  if (!ownerId) return null;
  const [user, admin, approved] = await Promise.all([getUser(ownerId), isAdmin(ownerId), isApproved(ownerId)]);
  if (!user || !(admin || approved)) return null;
  const roles = { isAdminUser: admin, isApprovedUser: approved };
  const reachable = new Set((getOrgAccessGrants().skills || []).map(lower));
  const channels = new Set(); // channel ids whose policy admits the owner right now
  for (const channel of await listChannels()) {
    const meta = channel.meta;
    if (!meta || meta.isDM) continue;
    if (!isAuthorized(meta, ownerId, false, roles)) continue;
    const channelId = meta.channelId || channel.channelId;
    channels.add(channelId);
    for (const s of sanitizeSkillGrantNames(withTemplateSkills(meta)?.skills || [])) reachable.add(lower(s));
    for (const s of channelScopedSkills(channelId)) reachable.add(lower(s));
  }
  for (const s of sanitizeSkillGrantNames(user.skills || [])) reachable.add(lower(s));
  const own = (skill) => skill.visibility === "personal" && skill.createdBy === ownerId;
  const inReach = (skill) => {
    if (!skill || skill.deleted) return false;
    if (skill.visibility === "personal") return own(skill);
    if (admin) return true;
    if (skill.channelScope) return channels.has(skill.channelScope) || reachable.has(lower(skill.slug));
    return reachable.has(lower(skill.slug)) || Boolean(skill.discoverable);
  };
  return {
    kind: "user",
    token,
    ownerId,
    admin,
    viewer: ownerId,
    channels,
    canRead: inReach,
    canExport: () => false,
    canManage: (skill) => {
      if (!skill || skill.deleted) return false;
      const tier = skillTier(skill);
      if (tier === "personal") return own(skill);
      if (tier === "channel") return admin || channels.has(skill.channelScope);
      return admin;
    },
    // A user token creates PERSONAL skills; a channel skill when it names a channel that admits
    // the owner; the organization tier only for an admin.
    createOptions: ({ channelId = "", organization = false } = {}) => {
      const id = String(channelId || "").trim();
      if (id) {
        if (!channels.has(id)) throw new Error(`you are not admitted to channel ${id}, so you cannot create a skill in its section`);
        return { personal: false, channelId: id };
      }
      if (organization) {
        if (!admin) throw new Error("only an admin creates organization skills; create a personal or channel skill, or propose one");
        return { personal: false, channelId: "" };
      }
      return { personal: true, channelId: "" };
    },
    reason: "",
  };
}

export async function resolveTokenScope(token) {
  if (!token) return null;
  return token.kind === "user" ? userTokenScope(token) : catalogTokenScope(token);
}
