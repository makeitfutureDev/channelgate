// Optional per-THREAD settings: variables, MCP connections and skill additions that apply to one
// thread of a conversation only. Each section is one `thread_overrides` row (kind
// `settings_<section>`), written whole with a compare-and-swap, so an Apply either lands
// completely or not at all and a stale settings card cannot overwrite a newer one.
//
// What a thread override can and cannot do is the security contract (AGENTS.md "A channel's
// secrets are write-only and never leave the channel"):
//   • It never rewrites channel metadata, the shared skill tree, the container's mounts, tool
//     policy, network switch or access membership. Runs READ it next to the channel; nothing else.
//   • Variables are placeholder-only. A thread variable is injected only into a proxy-mode
//     container run of that exact thread, as a `thread`-scope egress placeholder that the proxy
//     swaps on its fixed destination hosts only while that thread has live work and no other
//     thread, SSH session or editor is live in the shared container (egress/service.js). A value
//     without a fixed destination (a readable password, or a hidden secret that would need a
//     per-server admin approval) is refused on write and withheld at run time; legacy bridge mode
//     and the `/sudo` host lane never receive one. Values are never listed, returned or logged.
//   • Skills are additions only, from the shared catalog: never a personal skill (directly or by
//     `requires:`), never a removal of an organization or channel skill. They ride the per-run
//     overlay, not the durable `.claude/skills/` tree, so sibling threads never see them.
//   • MCP: the conversation's Composio and Make connections may be replaced (or disconnected) for
//     the thread; Cloud MCP selections may only be ADDED, and only by an administrator.
import { createHmac, randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";
import { emitConfigChange } from "../config/change-events.js";
import { MAX_CHANNEL_ENV_VARS, assertValidEnvName, assertValidEnvValue, normalizeChannelEnv } from "../config/channel-env.js";
import { assertValidSwapRuleFields, rulesFor } from "./egress/catalog-rules.js";
import { normalizeMakeToolboxUrl } from "./make-toolbox.js";
import { ACCESS_GRANT_FIELDS, isForeignPersonalSkill, sanitizeSkillGrantNames } from "./access-grants.js";

export const THREAD_SETTINGS_SECTIONS = Object.freeze(["secrets", "mcp", "skills"]);
export const THREAD_MCP_CONNECTION_FIELDS = Object.freeze(["composioToken", "composioTokenLabel", "makeToolboxUrl", "makeToolboxKey"]);
export const THREAD_MCP_SELECTION_FIELDS = Object.freeze(ACCESS_GRANT_FIELDS.filter((field) => field !== "skills"));
export const MAX_THREAD_SKILLS = 64;
export const MAX_THREAD_MCP_SELECTIONS = 64;
const MAX_TOKEN_BYTES = 16_384;
const MAX_SECTION_BYTES = 256_000;
// Stale-card fingerprints are keyed per process, so a digest that ever left memory could not be
// used to test guesses of a value offline. Cards hold the digest only; never a value.
const FINGERPRINT_KEY = randomBytes(32);

function kindOf(section) {
  if (!THREAD_SETTINGS_SECTIONS.includes(section)) throw new Error("Unknown thread settings section.");
  return `settings_${section}`;
}

function plainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function settingsFingerprint(value = {}) {
  return createHmac("sha256", FINGERPRINT_KEY).update(JSON.stringify(canonical(value ?? {}))).digest("hex");
}

// The rule a THREAD variable swaps under, or null when it has none it may use: a fixed set of
// destination hosts (a known credential name's catalog rule or the entry's own declared hosts).
// A readable value (no rule) and an approval rule (servers an admin approves per secret, on first
// use) are refused: neither is a destination the thread's own setter has bound it to.
export function threadVariableRule(name, entry, { value = undefined } = {}) {
  if (!entry || entry.exposure === "readable") return null;
  const rule = rulesFor(name, { ...entry, exposure: undefined, approvedHosts: undefined }, { value: value ?? entry.value });
  if (!rule || rule.approval || !Array.isArray(rule.hosts) || !rule.hosts.length) return null;
  return rule;
}

export function threadVariableRuleError(name) {
  return `${name} needs a fixed destination to be a thread variable: choose "Replace rule with hosts below" and list the HTTPS hosts it is used on. Thread variables are always hidden behind the egress proxy; readable values and secrets that need per-server admin approval can only be set on the channel.`;
}

function validSelection(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const identity = entry.id || entry.name || entry.serverName || entry.namespace;
  return typeof identity === "string" && identity.length > 0 && identity.length <= 200 && JSON.stringify(entry).length <= 4096;
}

function validateSecrets(value) {
  const out = {};
  if (value.env !== undefined) {
    const raw = plainObject(value.env, "Invalid thread variables.");
    const names = Object.keys(raw);
    if (names.length > MAX_CHANNEL_ENV_VARS) throw new Error(`A thread can override at most ${MAX_CHANNEL_ENV_VARS} variables.`);
    const env = {};
    for (const name of names) {
      if (assertValidEnvName(name) !== name) throw new Error("Invalid thread variable name.");
      const entry = plainObject(raw[name], "Invalid thread variable.");
      if (String(entry.provider || "local") !== "local") throw new Error("Thread variables are stored by ChannelGate only.");
      const rules = assertValidSwapRuleFields({ hosts: entry.hosts, headers: entry.headers, format: entry.format });
      const stored = {
        provider: "local",
        value: assertValidEnvValue(entry.value),
        ...Object.fromEntries(Object.entries(rules).filter(([, item]) => item !== undefined && !(Array.isArray(item) && !item.length))),
        setBy: String(entry.setBy || "").slice(0, 256),
        setAt: Number.isFinite(entry.setAt) ? entry.setAt : 0,
      };
      // Normalization must keep the entry whole: a dropped field would silently change its rule.
      if (!normalizeChannelEnv({ [name]: stored })[name]) throw new Error("Invalid thread variable.");
      if (!threadVariableRule(name, stored)) throw new Error(threadVariableRuleError(name));
      env[name] = stored;
    }
    if (names.length) out.env = env;
  }
  if (value.removed !== undefined) {
    if (!Array.isArray(value.removed) || value.removed.length > MAX_CHANNEL_ENV_VARS) throw new Error("Invalid hidden channel variables.");
    const removed = [...new Set(value.removed.map((name) => {
      const key = assertValidEnvName(name);
      if (key !== name) throw new Error("Invalid hidden channel variable.");
      return key;
    }))].sort();
    if (removed.some((name) => out.env?.[name])) throw new Error("A thread variable cannot be both set and hidden.");
    if (removed.length) out.removed = removed;
  }
  return out;
}

function validateMcp(value) {
  const out = {};
  for (const field of THREAD_MCP_CONNECTION_FIELDS) {
    if (value[field] === undefined) continue;
    const item = value[field];
    if (typeof item !== "string" || Buffer.byteLength(item) > MAX_TOKEN_BYTES || /[\r\n\0]/.test(item)) throw new Error("Invalid thread connection value.");
    if (field === "composioTokenLabel" && item.length > 200) throw new Error("That account label is too long.");
    if ((field === "composioToken" || field === "makeToolboxKey") && item && item.trim().length < 6) throw new Error("Connection tokens must contain at least six characters.");
    out[field] = field === "composioTokenLabel" ? item.trim() : item.trim();
  }
  // Make is a pair: both set (a replacement) or both empty (disconnected in this thread).
  if (Object.hasOwn(out, "makeToolboxUrl") || Object.hasOwn(out, "makeToolboxKey")) {
    const url = out.makeToolboxUrl ?? "", key = out.makeToolboxKey ?? "";
    if (Boolean(url) !== Boolean(key) || !Object.hasOwn(out, "makeToolboxUrl") || !Object.hasOwn(out, "makeToolboxKey")) throw new Error("A thread's Make MCP needs both its URL and its token.");
    if (url) out.makeToolboxUrl = normalizeMakeToolboxUrl(url);
  }
  if (Object.hasOwn(out, "composioTokenLabel") && !Object.hasOwn(out, "composioToken")) throw new Error("A thread's Composio label needs its own Composio token.");
  for (const field of THREAD_MCP_SELECTION_FIELDS) {
    if (value[field] === undefined) continue;
    if (!Array.isArray(value[field]) || value[field].length > MAX_THREAD_MCP_SELECTIONS || !value[field].every(validSelection)) throw new Error("Invalid thread MCP selection.");
    if (value[field].length) out[field] = structuredClone(value[field]);
  }
  return out;
}

function validateSkills(value) {
  if (value.skills === undefined) return {};
  if (!Array.isArray(value.skills) || value.skills.length > MAX_THREAD_SKILLS || value.skills.some((name) => typeof name !== "string")) throw new Error("Invalid thread skill selection.");
  const skills = sanitizeSkillGrantNames(value.skills);
  if (skills.length !== value.skills.length) throw new Error("Invalid thread skill selection.");
  return skills.length ? { skills } : {};
}

export function validateThreadSection(section, raw) {
  kindOf(section);
  const value = plainObject(raw ?? {}, "Thread settings must be an object.");
  const allowed = section === "secrets" ? ["env", "removed"] : section === "skills" ? ["skills"] : [...THREAD_MCP_CONNECTION_FIELDS, ...THREAD_MCP_SELECTION_FIELDS];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unsupported thread settings field.");
  const out = section === "secrets" ? validateSecrets(value) : section === "skills" ? validateSkills(value) : validateMcp(value);
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_SECTION_BYTES) throw new Error("Thread settings are too large.");
  return out;
}

function readRow(slug, threadKey, section) {
  const row = getDb().prepare("SELECT value FROM thread_overrides WHERE slug = ? AND thread_key = ? AND kind = ?").get(slug, threadKey, kindOf(section));
  return row ? row.value : "";
}

// A row that no longer validates (hand-edited, or written under other rules) is read FAIL-CLOSED,
// never dropped: dropping it would silently hand the thread the channel's account. Its variable
// NAMES stay (a name without a fixed destination is then withheld at run time, and the channel's
// value is not used in its place); a malformed connection reads as disconnected; additions that do
// not validate are left out (narrower). Writers always use the strict path.
function failClosed(section, raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (section === "secrets") {
    const env = normalizeChannelEnv(value.env);
    const removed = Array.isArray(value.removed) ? [...new Set(value.removed.filter((name) => typeof name === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(name) && !env[name]))].sort() : [];
    return { ...(Object.keys(env).length ? { env } : {}), ...(removed.length ? { removed } : {}) };
  }
  if (section === "skills") {
    const skills = sanitizeSkillGrantNames(value.skills).slice(0, MAX_THREAD_SKILLS);
    return skills.length ? { skills } : {};
  }
  const out = {};
  if (Object.hasOwn(value, "composioToken")) {
    try { Object.assign(out, validateMcp({ composioToken: value.composioToken, ...(value.composioToken ? { composioTokenLabel: value.composioTokenLabel ?? "" } : {}) })); }
    catch { out.composioToken = ""; }
  }
  if (Object.hasOwn(value, "makeToolboxUrl") || Object.hasOwn(value, "makeToolboxKey")) {
    try { Object.assign(out, validateMcp({ makeToolboxUrl: value.makeToolboxUrl, makeToolboxKey: value.makeToolboxKey })); }
    catch { Object.assign(out, { makeToolboxUrl: "", makeToolboxKey: "" }); }
  }
  for (const field of THREAD_MCP_SELECTION_FIELDS) {
    const list = Array.isArray(value[field]) ? value[field].filter(validSelection).slice(0, MAX_THREAD_MCP_SELECTIONS) : [];
    if (list.length) out[field] = structuredClone(list);
  }
  return out;
}

export function getThreadSettings(slug, threadKey, section) {
  kindOf(section);
  if (!slug || !threadKey) return {};
  const raw = readRow(slug, threadKey, section);
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  try { return validateThreadSection(section, parsed); } catch { return failClosed(section, parsed); }
}

export function threadSettingsForRun(slug, threadKey) {
  return Object.fromEntries(THREAD_SETTINGS_SECTIONS.map((section) => [section, getThreadSettings(slug, threadKey, section)]));
}

export function threadSectionFingerprint(slug, threadKey, section) {
  return settingsFingerprint(getThreadSettings(slug, threadKey, section));
}

// Replace one section whole. `expected` is the fingerprint the editor started from; a different
// current value refuses the write (another person, card or turn changed it meanwhile).
export function setThreadSettings(slug, threadKey, section, next, { expected } = {}) {
  const kind = kindOf(section);
  if (!slug || !threadKey) throw new Error("Thread settings need a conversation and a thread.");
  const value = validateThreadSection(section, next);
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (expected !== undefined && threadSectionFingerprint(slug, threadKey, section) !== expected) {
      throw new Error("This thread's settings changed while you were editing. Discard your changes and reopen this section.");
    }
    if (Object.keys(value).length) {
      db.prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES(?, ?, ?, ?) ON CONFLICT(slug, thread_key, kind) DO UPDATE SET value = excluded.value")
        .run(slug, threadKey, kind, JSON.stringify(value));
    } else {
      db.prepare("DELETE FROM thread_overrides WHERE slug = ? AND thread_key = ? AND kind = ?").run(slug, threadKey, kind);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
    throw error;
  }
  // Names what changed, never a value: the egress service revokes removed placeholders on it.
  emitConfigChange("thread-settings", { slug, threadKey, section });
  return value;
}

// ── Run-time projections ─────────────────────────────────────────────────────────────────────

// The thread's MCP CONNECTION overrides laid over the channel meta a run resolves integrations
// from. An empty token disconnects that connection in this thread only.
export function threadConnectionMeta(meta = {}, mcp = {}) {
  const out = { ...meta };
  if (Object.hasOwn(mcp, "composioToken")) {
    out.composioToken = mcp.composioToken;
    out.composioTokenLabel = mcp.composioTokenLabel || "";
  }
  if (Object.hasOwn(mcp, "makeToolboxUrl")) {
    out.makeToolboxUrl = mcp.makeToolboxUrl;
    out.makeToolboxKey = mcp.makeToolboxKey || "";
  }
  return out;
}

// The thread's grant TIER (access-grants.js): skill additions and Cloud MCP additions.
export function threadGrantTier(settings = {}) {
  const tier = {};
  if (settings.skills?.skills?.length) tier.skills = [...settings.skills.skills];
  for (const field of THREAD_MCP_SELECTION_FIELDS) if (settings.mcp?.[field]?.length) tier[field] = structuredClone(settings.mcp[field]);
  return tier;
}

// Write-time check for a thread skill addition: a shared catalog skill that exists, is not
// deleted, belongs to this conversation's section (or the shared library), and pulls in no
// personal skill through `requires:`. Throws a human sentence.
export function assertThreadSkillGrantable(name, { channelId = "", lookupSkill }) {
  const visited = new Set();
  const visit = (current, top) => {
    const key = String(current).toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    const skill = lookupSkill(current);
    if (!skill || skill.deleted) throw new Error(top ? `The skill ${name} is no longer available.` : `${name} requires ${current}, which is no longer available.`);
    if (isForeignPersonalSkill(skill, "")) throw new Error(top ? `${name} is a personal skill; only its author can use it.` : `${name} requires the personal skill ${current}, so it cannot be added to a thread.`);
    if (skill.channelScope && skill.channelScope !== channelId) throw new Error(`${name} belongs to another conversation's skills.`);
    for (const dependency of skill.requires || []) visit(dependency, false);
  };
  visit(name, true);
}
