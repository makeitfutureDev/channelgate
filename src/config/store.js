// Config store — the single source of truth for users, the channel index, and per-channel meta.
// Backed by SQLite (see ../db). Functions keep their original async signatures so the ~40 call
// sites are unchanged; the underlying reads/writes are synchronous SQLite calls that resolve
// immediately. Config that stays as JSON (settings.json, mcp-catalog.json, the per-channel
// .claude/settings.json lockdown file) is handled elsewhere — not here.
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import {
  gatewayRoot,
  configDir,
  channelsDir,
  logsDir,
  channelFolder,
  slugify,
} from "./paths.js";
import { getDb, toJson, fromJson } from "../db/index.js";
import { assertApprovedEnginesUpdate, assertChannelEngineApproved } from "../gateway/channel-engines.js";
import { assertRegistrationCapacity } from "../ee/registration-limits.js";
import { adminUserAuthorityChanged } from "./admin-accounts.js";
import { isApiPrincipal } from "./api-principal.js";
// Retired integrations' fields are dropped on the way IN, so a record can never be re-saved with
// one and no listing has to remember to mask it (see ./dead-fields.js).
import { stripDeadFields } from "./dead-fields.js";
import { emitConfigChange } from "./change-events.js";
import { DEFAULT_PLATFORM, isPlatformId, platformFolderNames } from "../platforms/registry.js";
import { workspaceProjection, workspaceSetup, WORKSPACE_FIELDS } from "./workspace-links.js";
const PLATFORM_FOLDER_NAMES = new Set(platformFolderNames());

// `nudges` moved from conversation metadata to user records. Retire this shape-specific key only
// at the channel boundary; unlike stripDeadFields(), this is also safe on internal reads because it
// is not a secret-retirement policy (some tests intentionally prove old secrets survive until a
// write while listing maskers still hide them).
function stripRetiredChannelFields(meta) {
  const record = meta;
  if (!record || !Object.hasOwn(record, "nudges")) return record;
  const { nudges: _retired, ...rest } = record;
  return rest;
}

// ── Bootstrap ───────────────────────────────────────────────────────────────
// Create the runtime dirs and open/migrate the database. Idempotent: safe every boot.
export async function ensureRoot() {
  await mkdir(configDir(), { recursive: true });
  await mkdir(channelsDir(), { recursive: true });
  await mkdir(logsDir(), { recursive: true });
  getDb(); // opens the DB, runs migrations, performs the one-time legacy import
  return gatewayRoot();
}

// ── Users (global) ────────────────────────────────────────────────────────────
// Shape: { "<platformUserId>": { name, composioToken, toolboxToken, isAdmin, approved,
//          nudges, skills[], allowedMcps[], allowedCodexMcps[] } }
export async function getUsers() {
  const rows = getDb().prepare("SELECT user_id, data FROM users").all();
  const out = {};
  for (const r of rows) out[r.user_id] = fromJson(r.data, {});
  return out;
}

export async function getUser(userId) {
  const row = getDb().prepare("SELECT data FROM users WHERE user_id = ?").get(userId);
  return row ? fromJson(row.data, null) : null;
}

// Merge a patch into one user record (create if absent). Returns the saved record.
// `approved` = on the approved-users list / cleared to use the bot. New users default to false
// (an admin approves them); the seeded MIF roster is approved.
export async function setUser(userId, patch) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT data FROM users WHERE user_id = ?").get(userId);
    if (!row && !isApiPrincipal(userId)) assertRegistrationCapacity("users", db);
    const existing = row ? fromJson(row.data, {}) : null;
    const next = {
      name: "", composioToken: "", toolboxToken: "", isAdmin: false,
      approved: false, skills: [], allowedMcps: [], allowedCodexMcps: [],
      allowedOpenCodeMcps: [], ...existing,
    };
    for (const [key, value] of Object.entries(patch || {})) {
      if (value !== undefined) next[key] = value;
    }
    const saved = stripDeadFields(next);
    db.prepare("INSERT INTO users(user_id, data) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data")
      .run(userId, toJson(saved));
    adminUserAuthorityChanged(db, userId, existing, saved);
    db.exec("COMMIT");
    emitConfigChange("user", { userId });
    return saved;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already gone */ }
    throw error;
  }
}

export async function isAdmin(userId) {
  return Boolean((await getUser(userId))?.isAdmin);
}

// Admin rank of a run's AUTHOR: a stored admin, or the HTTP run API principal, whose key is an
// admin credential (config/api-principal.js). Only for "who asked for this work" — never for who
// clicked, approved or signed in, where the API principal can never appear and must never count.
export async function isAdminPrincipal(userId) {
  return isApiPrincipal(userId) || (await isAdmin(userId));
}

// Approved = on the approved-users list. Admins are implicitly approved.
export async function isApproved(userId) {
  const u = await getUser(userId);
  return Boolean(u?.approved || u?.isAdmin);
}

export async function getComposioToken(userId) {
  return (await getUser(userId))?.composioToken || "";
}

export async function getToolboxToken(userId) {
  return (await getUser(userId))?.toolboxToken || "";
}

// ── Channels index (global) ─────────────────────────────────────────────────
// Shape: { "<channelId>": { slug, name, type, isDM, platform } }
export async function getChannelsIndex() {
  const rows = getDb().prepare("SELECT channel_id, data FROM channels").all();
  const out = {};
  for (const r of rows) out[r.channel_id] = fromJson(r.data, {});
  return out;
}

export async function getChannelEntry(channelId) {
  const row = getDb().prepare("SELECT data FROM channels WHERE channel_id = ?").get(channelId);
  return row ? fromJson(row.data, null) : null;
}

// Conversation kinds Slack actually reports on a message event. A stored value outside this set
// (missing, legacy, or a membership-event letter) is "unknown", and unknown is treated as PRIVATE
// everywhere downstream (see PUBLIC_CHANNEL_TYPES in slack/app.js) — so it must never be
// manufactured into a definite "channel".
const KNOWN_CHANNEL_TYPES = new Set(["channel", "group", "mpim", "im"]);

// Register (or update) a conversation in the index, allocating a stable slug once.
//
// The stored `type` is a SECURITY value, not cosmetic: it decides whether a private channel's name
// may appear in someone's App Home. It is therefore write-once-wins — an already-known type is
// never overwritten by a later caller. Synthetic events (a slash command, a 🤖 reaction, an App
// Home open) carry no real `channel_type`, and the old "default to channel" behaviour let one of
// them relabel a stored "group"/"mpim" as a public channel. An unknown type stays "" so it fails
// closed instead of pretending to be public.
export async function upsertChannelEntry(channelId, { name, type, isDM, platform } = {}) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT slug, data FROM channels WHERE channel_id = ?").get(channelId);
    const existing = row ? fromJson(row.data, {}) : null;
    if (!row) assertRegistrationCapacity("channels", db);
    let slug = row?.slug || slugify(name, channelId);
    // The collision loop runs whenever the slug was NEWLY computed — not only for brand-new
    // rows: a legacy row imported with an empty slug lands here too, and skipping the loop for
    // it would make every message throw on the unique index if the name collides. Numbering
    // starts at -2, matching migration 8's repair (base, base-2, base-3 …).
    if (!row?.slug) {
      const desired = slug;
      const suffix = `${desired}-${String(channelId).toLowerCase()}`;
      const takenByOther = (candidate) => {
        const hit = db.prepare("SELECT channel_id FROM channels WHERE slug = ?").get(candidate);
        return hit && hit.channel_id !== channelId;
      };
      for (let n = 1; takenByOther(slug); n++) {
        slug = n === 1 ? suffix : `${suffix}-${n}`;
      }
    }
    const entry = {
      slug,
      name: name ?? existing?.name ?? channelId,
      // Keep a type we already know; only fill in (or upgrade) one we don't.
      type: KNOWN_CHANNEL_TYPES.has(existing?.type)
        ? existing.type
        : (KNOWN_CHANNEL_TYPES.has(type) ? type : existing?.type ?? type ?? ""),
      isDM: isDM ?? existing?.isDM ?? false,
      // Which chat surface this conversation lives on. Write-once like `type`, and for the same
      // reason: it decides which reply modes and which operating-manual text the channel gets, and
      // a synthetic event carrying no platform must never relabel a live channel. Rows that predate
      // multi-platform support have no value and resolve to Slack (DEFAULT_PLATFORM) on read —
      // there was no other surface when they were written.
      platform: isPlatformId(existing?.platform)
        ? existing.platform
        : (isPlatformId(platform) ? platform : existing?.platform ?? platform ?? ""),
    };
    db.prepare("INSERT INTO channels(channel_id, slug, data) VALUES(?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET slug = excluded.slug, data = excluded.data")
      .run(channelId, slug, toJson(entry));
    db.exec("COMMIT");
    return entry;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ── Channel meta (per channel, keyed by slug) ───────────────────────────────
// Shape: { channelId, name, type, isDM, platform, allowedUsers[], allowedMcps[],
//          allowedCodexMcps[], skills[], adminMode, ... }
export function defaultChannelMeta({ channelId, name, type, isDM, platform }) {
  return {
    channelId,
    name: name ?? channelId,
    type: type ?? "channel",
    isDM: Boolean(isDM),
    // The chat surface. Read through platformOr()/capabilitiesFor() — never compared to a literal.
    platform: isPlatformId(platform) ? platform : DEFAULT_PLATFORM,
    access: "approved", // who can USE the channel: "approved" | "admins" | "none" (set from the gateway
    // default at join). Governs who's auto-granted in a channel; allowedUsers is the manual override.
    // Who can MANAGE this channel (modes, network, MCP servers, secrets' modes) from chat:
    // "admins" | "members" | "custom". Approved members by default (operator decision 2026-10-07:
    // approved users are vetted by the operator, and a channel whose members cannot change their
    // own settings stalls on an admin for every switch). Rows stored before this default keep the
    // value they hold; canManage() treats a missing field as "admins".
    manageAccess: "members",
    managers: [], // when manageAccess="custom": Slack user ids allowed to manage this channel.
    profile: isDM ? undefined : "read", // capability preset: read|worker|auto|full|lean|custom (see modes.js);
    // expands to the flags below on save. undefined/legacy channels derive it from the flags.
    allowedUsers: [], // empty = nobody until configured (fail closed). DMs auto-allow the peer.
    allowedMcps: [], // Claude catalog entries; both built-in Composio identities are separate.
    allowedCodexMcps: [], // Codex runtime app-family/server identities; enforced by codex launch overrides.
    skills: [], // skills added to this conversation (on top of its skill template)
    skillTemplate: "", // slug of the skill template this conversation follows ("" = none)
    adminMode: false, // channel-level escalation (still also requires an admin author)
    allowBash: false, // allow Bash + file-edit tools, still confined to the folder by the sandbox
    allowNetwork: false, // allow sandbox network egress (to the configured domains) for git/gh/curl
    autoMode: false, // autonomous: auto-approve permission prompts (no Slack buttons); still sandboxed
    cleanMode: false, // run bare: no MCP servers (gateway/composio/skills), no skills, no favorites block
    noDefaultTokens: false, // refuse the org-default token fallback here (channel/user tokens still apply)
    memory: undefined, // folder-scoped MEMORY.md: undefined = use the gateway default; true/false to override
    engine: "", // per-channel engine: "" = use the global default, or "claude" / "codex"
    codexAuthSource: "gateway", // gateway login, or a separate host-side login for this channel
    approvedTools: [], // tool names "approved forever" here — auto-approved without a prompt
    workDir: "", // custom absolute path to run Claude in (empty = the default gateway folder)
    syncDriveFolder: "", // Google Drive folder link to 2-way sync (scheduled) with this channel's working folder (empty = off)
    composioToken: "", // shared `composio` token; personal `composio-user` remains available too
    toolboxToken: "", // channel-wide Toolbox token used for everyone here (overrides per-user)
    makeToolboxUrl: "", // per-channel Make MCP toolbox server URL (key stays separate)
    makeToolboxKey: "", // per-channel Make MCP toolbox Bearer key
    model: "", // model override for this channel (empty = engine default)
    effort: "", // reasoning effort for this channel: none|low|medium|high|xhigh|max (engine-specific)
    template: isDM ? "user" : "", // DMs: "user"|"admin" org template, or "custom" (use own fields)
    dmUserId: "", // for DMs: the Slack user id of the peer (for name resolution)
  };
}

function workspaceRows() {
  return getDb().prepare("SELECT slug, data FROM channel_meta ORDER BY rowid").all()
    .map((row) => ({ slug: row.slug, meta: stripRetiredChannelFields(fromJson(row.data, {})) }));
}

export async function getChannelMeta(slug) {
  const { effectiveWorkDir } = await import("../gateway/folders.js");
  const rows = workspaceRows();
  return workspaceProjection(slug, rows.find((row) => row.slug === slug)?.meta || null, rows, effectiveWorkDir);
}

function prepareWorkspaceSave(slug, current, next, effectiveWorkDir, channelScopedSkills) {
  delete next.workspaceLink;
  // Link is derived from the folder, never accepted from a caller.
  delete next.workspaceOwnerSlug;
  delete next.workspaceOrigin;
  delete next.workspacePolicyIsDM;
  if (typeof current?.workspacePolicyIsDM === "boolean") next.workspacePolicyIsDM = current.workspacePolicyIsDM;
  if (current && current.workDir === next.workDir) {
    if (current.workspaceOwnerSlug) next.workspaceOwnerSlug = current.workspaceOwnerSlug;
    if (current.workspaceOrigin) next.workspaceOrigin = current.workspaceOrigin;
  }
  const rows = workspaceRows();
  // Resolve an existing default workspace before applying the custom-directory allowlist.
  // The hint comes from stored assignments, never caller-supplied ownership metadata.
  if (next.workDir && (!current || current.workDir !== next.workDir)) {
    const assigned = rows.find((row) => row.slug !== slug && effectiveWorkDir(row.slug, { ...row.meta, cleanMode: false }) === next.workDir.trim());
    if (assigned) {
      const source = workspaceProjection(assigned.slug, assigned.meta, rows, effectiveWorkDir);
      next.workspaceOwnerSlug = source.workspaceOwnerSlug || assigned.slug;
      next.workspaceOrigin = source.workspaceOrigin || { slug: next.workspaceOwnerSlug, platform: source.workspaceLink?.platform || source.platform };
    }
  }
  const cwd = effectiveWorkDir(slug, { ...next, cleanMode: false });
  const oldCwd = current && effectiveWorkDir(slug, { ...current, cleanMode: false });
  if (current && oldCwd === cwd) {
    if (current.workspaceOwnerSlug) next.workspaceOwnerSlug = current.workspaceOwnerSlug;
  } else {
    const peer = rows.find((row) => row.slug !== slug && effectiveWorkDir(row.slug, { ...row.meta, cleanMode: false }) === cwd);
    if (peer) next.workspaceOwnerSlug = workspaceProjection(peer.slug, peer.meta, rows, effectiveWorkDir).workspaceOwnerSlug || peer.slug;
  }
  const candidates = rows.map((row) => row.slug === slug ? { slug, meta: next } : row);
  if (!candidates.some((row) => row.slug === slug)) candidates.push({ slug, meta: next });
  const projected = workspaceProjection(slug, next, candidates, effectiveWorkDir);
  const previous = current && workspaceProjection(slug, current, rows, effectiveWorkDir);
  if (!projected.workspaceLink && previous?.workspaceLink) {
    projected.skills = retainWorkspaceSectionSkills(projected, previous.workspaceLink.channelId, channelScopedSkills);
    if (projected.isDM) projected.template = "custom";
  }
  if (projected.workspaceLink && previous?.workspaceLink?.slug === projected.workspaceLink.slug
      && current?.workDir === next.workDir) {
    for (const field of WORKSPACE_FIELDS) {
      if (JSON.stringify(next[field]) !== JSON.stringify(projected[field])) {
        throw Object.assign(new Error(`This setting is linked to ${projected.workspaceLink.name}. Edit the source conversation's shared setup, or choose a separate working folder.`),
          { code: "workspace_setting_linked", status: 409, statusCode: 409 });
      }
    }
  }
  if (projected.workspaceLink) {
    const source = rows.find((row) => row.slug === projected.workspaceLink.slug);
    projected.workspaceOrigin = source?.meta.workspaceOrigin || { slug: projected.workspaceLink.slug, platform: projected.workspaceLink.platform };
  }
  delete projected.workspaceLink;
  return projected;
}

// Section grants are implicit while linked. On separation they become explicit grants so
// changing the section identity does not silently revoke the folder's existing skills.
function retainWorkspaceSectionSkills(meta, channelId, channelScopedSkills) {
  const off = new Set((meta.skillsOff || []).map((name) => name.toLowerCase()));
  return [...new Set([...(meta.skills || []), ...channelScopedSkills(channelId).filter((name) => !off.has(name.toLowerCase()))])];
}

// Keep a fallback snapshot for explicit unlinking or an owner moving to another folder.
// Normal reads always project the live owner; snapshots never override a live source.
function snapshotWorkspaceFollowers(db, slug, current, next, effectiveWorkDir, channelScopedSkills) {
  if (!current) return [];
  const rows = workspaceRows();
  if (workspaceProjection(slug, current, rows, effectiveWorkDir).workspaceLink) return [];
  const changed = [];
  const oldCwd = effectiveWorkDir(slug, { ...current, cleanMode: false });
  const sameFolder = oldCwd === effectiveWorkDir(slug, { ...next, cleanMode: false });
  const setup = workspaceSetup(sameFolder ? next : current);
  for (const row of rows) {
    if (row.slug === slug || workspaceProjection(row.slug, row.meta, rows, effectiveWorkDir).workspaceLink?.slug !== slug) continue;
    const copy = { ...row.meta, workspaceOwnerSlug: slug, workspaceOrigin: current.workspaceOrigin || { slug, platform: current.platform } };
    for (const field of WORKSPACE_FIELDS) {
      if (Object.hasOwn(setup, field)) copy[field] = setup[field];
      else delete copy[field];
    }
    copy.workspacePolicyIsDM = current.workspacePolicyIsDM ?? Boolean(current.isDM || current.type === "im");
    if (!sameFolder) {
      copy.skills = retainWorkspaceSectionSkills(copy, current.channelId, channelScopedSkills);
      if (copy.isDM) copy.template = "custom";
    }
    if (JSON.stringify(copy) === JSON.stringify(row.meta)) continue;
    db.prepare("UPDATE channel_meta SET data = ? WHERE slug = ?").run(toJson(copy), row.slug);
    changed.push(row.slug);
  }
  return changed;
}

// Gate policy writes at the store boundary so internal callers and tools share the same rules.
function validateChannelPolicy(current, next) {
  // A whole-record save omitting an existing restriction must not clear it by accident.
  if (!Object.hasOwn(next, "approvedEngines") && Object.hasOwn(current || {}, "approvedEngines")) {
    next.approvedEngines = current.approvedEngines;
  }
  if (Object.hasOwn(next, "approvedEngines")) {
    next.approvedEngines = assertApprovedEnginesUpdate(current, next.approvedEngines);
  }
  if (next.engine && next.engine !== current?.engine) assertChannelEngineApproved(next, next.engine);
  if (next.codexAuthSource === "channel" && next.codexAuthSource !== current?.codexAuthSource) {
    assertChannelEngineApproved(next, "codex");
  }
  return next;
}

export async function saveChannelMeta(slug, meta) {
  const { channelScopedSkills } = await import("../gateway/skills/templates.js");
  const { effectiveWorkDir } = await import("../gateway/folders.js");
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT data FROM channel_meta WHERE slug = ?").get(slug);
    const current = row ? fromJson(row.data, null) : null;
    const record = validateChannelPolicy(current, prepareWorkspaceSave(slug, current, stripDeadFields(stripRetiredChannelFields({ ...meta })), effectiveWorkDir, channelScopedSkills));
    const followers = snapshotWorkspaceFollowers(db, slug, current, record, effectiveWorkDir, channelScopedSkills);
    db.prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?) ON CONFLICT(slug) DO UPDATE SET data = excluded.data")
      .run(slug, toJson(record));
    db.exec("COMMIT");
    emitConfigChange("channel-meta", { slug });
    for (const follower of followers) emitConfigChange("channel-meta", { slug: follower });
    return getChannelMeta(slug);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already gone */ }
    throw error;
  }
}

// Atomically merge a PARTIAL patch into one channel's meta. The read-modify-write runs inside a
// BEGIN IMMEDIATE transaction, which takes the SQLite write lock up front — so concurrent writers
// (the daemon and the spawned MCP server process share this DB) serialize instead of clobbering
// each other's whole-record saves. These fields ARE the security posture (adminMode, allowBash,
// allowedMcps…), so a lost update here is a lost lockdown change. `patch` is either an object of
// just the keys to change, or a SYNCHRONOUS function (currentMeta|null → partial) for updates that
// must derive from the current value (e.g. appending to allowedMcps); a function returning null
// aborts (nothing written — e.g. "channel not set up yet"). Returns the merged record, or null
// when aborted.
export async function patchChannelMeta(slug, patch) {
  const { channelScopedSkills } = await import("../gateway/skills/templates.js");
  const { effectiveWorkDir } = await import("../gateway/folders.js");
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT data FROM channel_meta WHERE slug = ?").get(slug);
    const current = row ? stripRetiredChannelFields(fromJson(row.data, {})) : null;
    const effectiveCurrent = current && workspaceProjection(slug, current, workspaceRows(), effectiveWorkDir);
    const partial = typeof patch === "function" ? patch(effectiveCurrent) : patch;
    if (partial == null) {
      db.exec("ROLLBACK");
      return null;
    }
    const next = validateChannelPolicy(current, prepareWorkspaceSave(slug, current, stripDeadFields(stripRetiredChannelFields({ ...(effectiveCurrent || {}), ...partial })), effectiveWorkDir, channelScopedSkills));
    const followers = snapshotWorkspaceFollowers(db, slug, current, next, effectiveWorkDir, channelScopedSkills);
    db.prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?) ON CONFLICT(slug) DO UPDATE SET data = excluded.data").run(slug, toJson(next));
    db.exec("COMMIT");
    emitConfigChange("channel-meta", { slug });
    for (const follower of followers) emitConfigChange("channel-meta", { slug: follower });
    return getChannelMeta(slug);
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already gone */
    }
    throw e;
  }
}

// List all known channels by reading the index plus their meta (for the admin UI).
export async function listChannels() {
  const index = await getChannelsIndex();
  const out = [];
  for (const [channelId, entry] of Object.entries(index)) {
    const meta = (await getChannelMeta(entry.slug)) ?? null;
    out.push({ channelId, ...entry, meta });
  }
  return out;
}

// Recover folders that exist on disk but might be missing from the index (defensive).
// The channels root is one level of PLATFORM folders (slack/, teams/, google-chat/) with the
// per-channel folders beneath them, so this descends one level and returns { slug, platform }.
export async function listChannelFolders() {
  const out = [];
  let platforms = [];
  try {
    platforms = (await readdir(channelsDir(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const platform of platforms) {
    if (!PLATFORM_FOLDER_NAMES.has(platform)) continue;
    try {
      for (const d of await readdir(path.join(channelsDir(), platform), { withFileTypes: true })) {
        if (d.isDirectory()) out.push({ slug: d.name, platform });
      }
    } catch {
      /* platform folder vanished */
    }
  }
  return out;
}

export { channelFolder };
