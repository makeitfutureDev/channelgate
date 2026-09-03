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

export function sanitizeSkillGrantNames(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!SAFE_SKILL_NAME.test(name) || seen.has(name)) continue;
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
} = {}) {
  const user = untrustedPrincipal ? {} : ((await loadUser(authorId)) || {});
  return {
    shared: resolveAccessGrants({ organization, channel }),
    effective: resolveAccessGrants({ organization, channel, user }),
    user: resolveAccessGrants({ user }),
  };
}

export async function resolveRunUserIdentity({
  authorId = "",
  untrustedPrincipal = false,
  needsApproval = false,
  loadComposioToken = async () => "",
  loadSkillsToken = async () => "",
  loadToolboxToken = async () => "",
  loadIsAdmin = async () => false,
  loadIsApproved = async () => false,
} = {}) {
  if (untrustedPrincipal) {
    return { composioToken: "", skillsToken: "", toolboxToken: "", isAdmin: false, isApproved: false };
  }
  const [composioToken, skillsToken, toolboxToken, isAdmin, isApproved] = await Promise.all([
    loadComposioToken(authorId),
    loadSkillsToken(authorId),
    loadToolboxToken(authorId),
    loadIsAdmin(authorId),
    needsApproval ? loadIsApproved(authorId) : false,
  ]);
  return { composioToken, skillsToken, toolboxToken, isAdmin: Boolean(isAdmin), isApproved: Boolean(isApproved) };
}

export function userOnlySkillGrants({ shared = {}, effective = {} } = {}) {
  const durable = new Set(sanitizeSkillGrantNames(shared.skills));
  return sanitizeSkillGrantNames(effective.skills).filter((name) => !durable.has(name));
}
