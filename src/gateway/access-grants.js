// Effective tool grants are a live union of three independently managed tiers:
// organization defaults + conversation grants + the active user's grants. The union is resolved
// for every run, so changing the organization tier immediately affects existing channels; nothing
// is copied when the bot joins a channel.

export const ACCESS_GRANT_FIELDS = [
  "skills",
  "allowedMcps",
  "allowedCodexMcps",
  "allowedOpenCodeMcps",
];

// Skill grants become directory names under an engine's project-local skills folder. Keep them
// to one safe path segment on every input path (admin API, legacy/manual config, direct store
// calls), trim whitespace, and dedupe deterministically. Colons and spaces remain valid because
// existing skill/plugin names may use them; path separators, controls, and dot traversal do not.
const SAFE_SKILL_NAME = /^(?!\.{1,2}$)[^\u0000-\u001f\u007f/\\]{1,160}$/;
export const RETIRED_STANDALONE_SKILLS = Object.freeze(["video-understanding"]);
const RETIRED_STANDALONE_SKILL_KEYS = new Set(RETIRED_STANDALONE_SKILLS.map((name) => name.toLowerCase()));

export function sanitizeSkillGrantNames(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!SAFE_SKILL_NAME.test(name) || RETIRED_STANDALONE_SKILL_KEYS.has(name.toLowerCase()) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function entryKey(value) {
  if (typeof value === "string") return `string:${value}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const identity = value.id || value.name || value.serverName || value.namespace;
  return identity ? `object:${String(identity)}` : "";
}

export function unionGrantEntries(...tiers) {
  const out = new Map();
  for (const tier of tiers) {
    if (!Array.isArray(tier)) continue;
    for (const value of tier) {
      const key = entryKey(value);
      if (!key) continue;
      // More-specific tiers replace the stored shape while preserving the original stable order.
      out.set(key, value);
    }
  }
  return [...out.values()];
}

export function resolveAccessGrants({ organization = {}, channel = {}, user = {} } = {}) {
  return Object.fromEntries(
    ACCESS_GRANT_FIELDS.map((field) => [
      field,
      field === "skills"
        ? unionGrantEntries(
            sanitizeSkillGrantNames(organization?.[field]),
            sanitizeSkillGrantNames(channel?.[field]),
            sanitizeSkillGrantNames(user?.[field]),
          )
        : unionGrantEntries(organization?.[field], channel?.[field], user?.[field]),
    ]),
  );
}

// Is `skill` another person's personal skill, as seen by `ownerId`? An empty owner (the
// organization tier, a channel, a template) owns no personal skill, so every personal one is
// foreign to it.
export function isForeignPersonalSkill(skill, ownerId = "") {
  return skill?.visibility === "personal" && (!ownerId || skill.createdBy !== ownerId);
}

// The names in `next` that were not already in `current` and resolve to someone else's personal
// skill. Save paths refuse these: a personal skill belongs to its author's own tier only. Grants
// that were stored before this check stay untouched, so an unrelated save never fails on them; the
// run skips them (filterSkillGrants) and the admin UI offers them for removal.
export function newForeignPersonalSkillGrants(next, current = [], { ownerId = "", lookupSkill = () => null } = {}) {
  const had = new Set(sanitizeSkillGrantNames(current).map((name) => name.toLowerCase()));
  return sanitizeSkillGrantNames(next).filter((name) => !had.has(name.toLowerCase()) && isForeignPersonalSkill(lookupSkill(name), ownerId));
}

export function foreignPersonalSkillError(names, { tier = "user" } = {}) {
  const list = names.map((name) => `"${name}"`).join(", ");
  return tier === "user"
    ? `${list} ${names.length === 1 ? "is" : "are"} another person's personal skill${names.length === 1 ? "" : "s"}. Only its author can use a personal skill; make it an organization skill first to share it.`
    : `${list} ${names.length === 1 ? "is a personal skill" : "are personal skills"} and cannot be granted here. Make ${names.length === 1 ? "it" : "them"} an organization skill first.`;
}

// Tombstones preserve grants for catalog history/restoration, but an author's deleted personal
// skill is no longer an active instruction. Omit only that proven state, never an unknown or
// unavailable source. Check ownership before considering deletion, including dependencies, so
// a stale or forged grant cannot turn another author's private skill into a readable overlay.
// A grant that names another person's personal skill — directly or through `requires:` — is
// SKIPPED, never loaded, and reported in `skipped` so the run can say so; it does not fail the
// turn, because one bad stored grant would otherwise lock the person out of every message.
//
// The same rule applies to the SHARED tiers (organization, channel, its template): there the
// owner is "" and EVERY personal skill is foreign — a personal skill loads only from its author's
// own grants, never for everyone in a conversation. `tier` labels each skipped entry.
function filterSkillGrants(names, authorId, lookupSkill, tier = "user") {
  const skipped = [];
  const retained = [];
  for (const name of sanitizeSkillGrantNames(names)) {
    const skill = lookupSkill(name);
    if (isForeignPersonalSkill(skill, authorId)) {
      skipped.push({ name, tier, reason: "foreign-personal" });
      continue;
    }
    if (authorId && skill?.deleted && skill.ownerKind === "local" && skill.visibility === "personal") continue;
    // Walk this grant's dependency closure; a foreign personal skill anywhere in it means the
    // grant cannot be materialized without exposing that skill, so the whole grant is skipped.
    const visited = new Set();
    let blockedBy = "";
    const visit = (dependencyName) => {
      const key = String(dependencyName).toLowerCase();
      if (blockedBy || visited.has(key)) return;
      visited.add(key);
      const dependency = lookupSkill(dependencyName);
      if (isForeignPersonalSkill(dependency, authorId)) { blockedBy = String(dependencyName); return; }
      if (!dependency || dependency.deleted) return;
      for (const next of dependency.requires || []) visit(next);
    };
    visited.add(name.toLowerCase());
    if (skill && !skill.deleted) for (const dependency of skill.requires || []) visit(dependency);
    if (blockedBy) {
      skipped.push({ name, tier, reason: "foreign-personal-dependency", dependency: blockedBy });
      continue;
    }
    retained.push(name);
  }
  return { names: retained, skipped };
}

// The organization + channel skill names that may materialize for everyone in a conversation:
// personal skills (and grants that require one) are dropped. folders.js applies this to the
// durable workspace, run.js to the per-run grants, so neither path can load one.
export function sharedSkillGrants({ organization = [], channel = [], lookupSkill = () => null } = {}) {
  const org = filterSkillGrants(organization, "", lookupSkill, "organization");
  const chan = filterSkillGrants(channel, "", lookupSkill, "channel");
  return { organization: org.names, channel: chan.names, skipped: [...org.skipped, ...chan.skipped] };
}

// The note a run carries when grants were skipped. Personal-tier skips are the author's own
// grants; shared-tier skips are a channel/organization setting an admin must fix.
export function skippedSkillGrantsWarning(skipped = []) {
  if (!skipped.length) return "";
  const item = (entry) => entry.reason === "foreign-personal-dependency" ? `${entry.name} (requires ${entry.dependency})` : entry.name;
  const it = (n) => (n === 1 ? "it" : "them");
  const lines = [];
  const mine = skipped.filter((entry) => (entry.tier || "user") === "user");
  if (mine.length) {
    lines.push(`⚠️ Skipped ${mine.length === 1 ? "a skill" : `${mine.length} skills`} in your personal grants: ${mine.map(item).join(", ")} — ${mine.length === 1 ? "it is" : "they are"} another person's personal skill. An admin can remove ${it(mine.length)} under Users, or the author can make ${it(mine.length)} an organization skill. Continuing without ${it(mine.length)}.`);
  }
  for (const tier of ["channel", "organization"]) {
    const shared = skipped.filter((entry) => entry.tier === tier);
    if (!shared.length) continue;
    const where = tier === "channel" ? "this conversation's skills" : "the organization's skills";
    lines.push(`⚠️ Skipped ${shared.length === 1 ? "a skill" : `${shared.length} skills`} in ${where}: ${shared.map(item).join(", ")} — a personal skill loads only for its author. An admin can remove ${it(shared.length)} in ${tier === "channel" ? "this conversation's settings" : "Settings → organization grants"}, or the author can make ${it(shared.length)} an organization skill. Continuing without ${it(shared.length)}.`);
  }
  return `${lines.join("\n")}\n\n`;
}

// Resolve the durable (organization + channel) grants separately from the active principal's
// effective grants. HTTP run callers supply an author id but do not authenticate that Slack user,
// so an untrusted principal must not even trigger a stored-user lookup: naming somebody else's
// public Slack id can never inherit their private connector/skill grants.
export async function resolveRunAccessGrants({
  organization = {},
  channel = {},
  authorId = "",
  untrustedPrincipal = false,
  loadUser = async () => null,
  lookupSkill = () => null,
} = {}) {
  const storedUser = untrustedPrincipal ? {} : ((await loadUser(authorId)) || {});
  const userSkills = filterSkillGrants(storedUser.skills, authorId, lookupSkill, "user");
  const user = { ...storedUser, skills: userSkills.names };
  const shared = sharedSkillGrants({ organization: organization?.skills, channel: channel?.skills, lookupSkill });
  const org = { ...organization, skills: shared.organization };
  const chan = { ...channel, skills: shared.channel };
  return {
    shared: resolveAccessGrants({ organization: org, channel: chan }),
    effective: resolveAccessGrants({ organization: org, channel: chan, user }),
    user: resolveAccessGrants({ user }),
    skippedSkills: [...shared.skipped, ...userSkills.skipped],
  };
}

export async function resolveRunUserIdentity({
  authorId = "",
  untrustedPrincipal = false,
  needsApproval = false,
  loadComposioToken = async () => "",
  loadToolboxToken = async () => "",
  loadIsAdmin = async () => false,
  loadIsApproved = async () => false,
} = {}) {
  if (untrustedPrincipal) {
    return { composioToken: "", toolboxToken: "", isAdmin: false, isApproved: false };
  }
  const [composioToken, toolboxToken, isAdmin, isApproved] = await Promise.all([
    loadComposioToken(authorId),
    loadToolboxToken(authorId),
    loadIsAdmin(authorId),
    needsApproval ? loadIsApproved(authorId) : false,
  ]);
  return { composioToken, toolboxToken, isAdmin: Boolean(isAdmin), isApproved: Boolean(isApproved) };
}

export function userOnlySkillGrants({ shared = {}, effective = {} } = {}) {
  const durable = new Set(sanitizeSkillGrantNames(shared.skills));
  return sanitizeSkillGrantNames(effective.skills).filter((name) => !durable.has(name));
}
