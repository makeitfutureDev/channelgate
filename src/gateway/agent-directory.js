// Specialist discovery is a live, audience-scoped projection of shared channel metadata. Never
// put the resulting directory in a shared skill file: a different audience has a different view.
import { getChannelMeta, getUser, listChannels } from "../config/store.js";
import { getOrgAccessGrants } from "../config/settings.js";
import { isAuthorized } from "./modes.js";
import { resolveAccessGrants } from "./access-grants.js";
import { withTemplateSkills } from "./skills/templates.js";
import { getSkill, effectiveRevisionFor } from "./skills/catalog.js";
import { resolveSkillProfile } from "./skills/resolve.js";
import { platformOfConversation } from "../platforms/ids.js";
import { prepareDirectoryVerifier, readAgentDirectoryMetadata } from "./agent-directory-refresh.js";

const MAX_RESULTS = 50;
const MAX_SKILLS = 40;
const MAX_PAGE_BYTES = 64 * 1024;
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const text = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";

export function sanitizeAgentDirectoryProfile(value = {}) {
  return {
    description: text(value?.description, 600),
    examples: Array.isArray(value?.examples) ? [...new Set(value.examples.map((entry) => text(entry, 160)).filter(Boolean))].slice(0, 6) : [],
    hidden: value?.hidden === true,
  };
}

function eligible(entry, meta) {
  if (!entry?.channelId || !entry.slug || !meta || entry.isDM || meta.isDM) return false;
  if (!["channel", "group"].includes(entry.type) || !["channel", "group"].includes(meta.type)) return false;
  if (entry.disabled || entry.archived || entry.deleted || meta.disabled || meta.archived || meta.deleted) return false;
  return !meta.cleanMode && meta.agentDirectory?.hidden !== true;
}

function sharedSkill(skill) {
  return skill && skill.visibility !== "personal" && !skill.deleted && !skill.excluded && skill.enabled !== false;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function searchScore(agent, terms) {
  if (!terms.length) return 1;
  const primary = `${agent.name} ${agent.description} ${agent.examples.join(" ")}`.toLowerCase();
  const skills = agent.skills.map((skill) => `${skill.slug} ${skill.name} ${skill.description}`).join(" ").toLowerCase();
  return terms.reduce((score, term) => score + (primary.includes(term) ? 3 : 0) + (skills.includes(term) ? 1 : 0), 0);
}

function boundedAgent(agent, terms) {
  const ranked = agent.skills.map((skill, order) => ({
    skill, order,
    score: terms.reduce((score, term) => score + (`${skill.slug} ${skill.name} ${skill.description}`.toLowerCase().includes(term) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score || a.order - b.order);
  const result = { ...agent, skills: ranked.slice(0, MAX_SKILLS).map(({ skill }) => skill), skillsTotal: ranked.length, skillsTruncated: ranked.length > MAX_SKILLS };
  // The character limits also admit multibyte text. Trim summaries further when needed so even
  // a Unicode-heavy agent fits in one bounded page, preserving the highest query matches.
  while (result.skills.length && jsonBytes(result) > MAX_PAGE_BYTES - 512) {
    result.skills.pop();
    result.skillsTruncated = true;
  }
  return result;
}

export async function searchAgentDirectory({
  query = "", limit = 20, offset = 0, createdBy = "", channelId = "",
  loadChannels = listChannels, loadMeta = getChannelMeta, loadUser = getUser,
  loadOrganization = getOrgAccessGrants, withSkills = withTemplateSkills,
  lookupSkill = getSkill, revisionFor = effectiveRevisionFor,
  prepareVerifier = prepareDirectoryVerifier, loadDirectoryMetadata = readAgentDirectoryMetadata,
} = {}) {
  const empty = { agents: [], returned: 0, hasMore: false, nextOffset: null };
  if (!createdBy || !channelId) return empty;
  const user = await loadUser(createdBy);
  const auth = { isAdminUser: user?.isAdmin === true, isApprovedUser: user?.approved === true };
  const channels = await loadChannels();
  const source = channels.find((entry) => entry.channelId === channelId);
  if (!source?.slug) return empty;
  const sourceAuthorized = async () => {
    const meta = await loadMeta(source.slug);
    return meta && !meta.disabled && !meta.archived && !meta.deleted && isAuthorized(meta, createdBy, Boolean(source.isDM || meta.isDM), auth);
  };
  if (!(await sourceAuthorized())) return empty;
  const organization = await loadOrganization();
  let cached = {};
  try { cached = (await loadDirectoryMetadata()) || {}; } catch { /* Missing cache takes the live path. */ }
  const terms = [...new Set(text(query, 300).toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 24);
  const take = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_RESULTS, Math.trunc(limit))) : 20;
  const start = Number.isFinite(offset) ? Math.max(0, Math.min(10000, Math.trunc(offset))) : 0;
  const candidates = [];
  const seen = new Set();
  const agentFor = (entry, meta, descriptor) => {
    const profile = sanitizeAgentDirectoryProfile(meta.agentDirectory);
    const grants = resolveAccessGrants({ organization, channel: withSkills({ ...meta, channelId: entry.channelId }) });
    const resolved = resolveSkillProfile(grants.skills, {
      // Apply privacy before traversal as well as before output: a private dependency must not
      // contribute descendants, query hits, warnings, or counts to the shared profile.
      lookup: (name) => { const skill = lookupSkill(name); return sharedSkill(skill) ? skill : null; },
      revisionFor,
    });
    const skills = resolved.active.filter((item) => sharedSkill(item.skill)).map((item) => ({
      slug: text(item.slug, 160), name: text(item.name || item.slug, 160), description: text(item.description, 600),
    }));
    return {
      channelId: entry.channelId,
      name: text(descriptor.name || entry.name, 160),
      platform: platformOfConversation(entry.channelId),
      url: safeUrl(descriptor.url),
      description: profile.description || text(descriptor.description, 600),
      examples: profile.examples,
      skills,
      verifiedAt: text(descriptor.verifiedAt, 40),
    };
  };
  for (const entry of channels) {
    if (!entry?.slug || !entry.channelId) continue;
    if (seen.has(entry?.channelId)) continue;
    seen.add(entry?.channelId);
    const meta = await loadMeta(entry.slug);
    if (!eligible(entry, meta) || !isAuthorized(meta, createdBy, false, auth)) continue;
    const descriptor = Object.hasOwn(cached, entry.channelId) ? cached[entry.channelId] : null;
    const agent = agentFor(entry, meta, descriptor || {});
    // Cached purpose/name narrows the expensive platform calls. Current index names, curated
    // purpose/examples and LIVE shared skills always participate, even before the nightly tick.
    const score = searchScore({ ...agent, name: `${text(entry.name, 160)} ${agent.name}` }, terms);
    if (descriptor && !score) continue;
    // An uncached channel gets a live attempt so first boot and newly registered channels work.
    candidates.push({ entry, score, name: agent.name });
  }
  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.entry.channelId.localeCompare(b.entry.channelId));
  if (!candidates.length) return empty;
  let verify;
  try { verify = await prepareVerifier({ createdBy, channelId }); } catch { return empty; }
  if (typeof verify !== "function") return empty;
  const matches = [];
  let hasMore = false;
  let visibleBeforePage = 0;
  for (const { entry } of candidates) {
    // The current policy is read again after platform verification. Neither a persisted snapshot
    // nor the index's embedded meta can keep a revoked/hidden channel in the response.
    let meta = await loadMeta(entry.slug);
    if (!eligible(entry, meta) || !isAuthorized(meta, createdBy, false, auth)) continue;
    let verified;
    try { verified = await verify(entry); } catch { continue; }
    if (verified?.visible !== true || verified.isDM || verified.archived || !["channel", "group"].includes(verified.type)) continue;
    meta = await loadMeta(entry.slug);
    if (!eligible(entry, meta) || !isAuthorized(meta, createdBy, false, auth)) continue;
    const agent = agentFor(entry, meta, verified);
    if (!searchScore(agent, terms)) continue;
    if (visibleBeforePage++ < start) continue;
    const bounded = boundedAgent(agent, terms);
    const prospective = [...matches, bounded];
    if (matches.length >= take || jsonBytes({ agents: prospective, returned: prospective.length, hasMore: false, nextOffset: null }) > MAX_PAGE_BYTES) {
      hasMore = true;
      break;
    }
    matches.push(bounded);
  }
  if (!(await sourceAuthorized())) return empty;
  const agents = matches;
  return { agents, returned: agents.length, hasMore, nextOffset: hasMore ? start + agents.length : null };
}
