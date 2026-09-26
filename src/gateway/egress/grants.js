// Placeholder grants: what a channel container holds instead of a secret, and how the proxy gets
// back to the real value.
//
// Why: a container is a shared trust domain (every admitted member runs as the same uid and can
// read every process's environment), so a credential it holds is only safe if it is worthless
// outside. A grant row maps the placeholder the container holds to WHERE the value lives — the
// scope, the channel, the owner and the secret's NAME — never to the value: that is resolved LIVE
// at swap time from the store that owns it (the organization's settings, the channel's meta, the
// person's user row, the Claude relay). So a rotation is live with no re-issue, and a removal
// REVOKES the row, so a placeholder copied out before the removal dies with the secret; re-adding
// the secret mints a new placeholder.
//
// Placeholders are stable per key — (scope, channel, owner, name) — so a warm engine process, a
// background job and the next turn all hold the same string, and the pool fingerprint does not
// churn on a rotation. Scopes (DB spelling → placeholder letter): organization → o (channel ''),
// channel → c, personal → p (per channel AND author: another author's turn never receives it),
// relay → r (the Claude access-token relay, per channel).
import { getDb } from "../../db/index.js";
import { getChannelEntry, getChannelMeta } from "../../config/store.js";
import { normalizeChannelEnv, resolveChannelEnv, safeSpawnEnv } from "../../config/channel-env.js";
import { getOrgEnv, getUserEnv, mergeRunEnv, resolveOrgEnv, resolveUserEnv } from "../../config/scoped-env.js";
import { getContainerRuntime } from "../../config/settings.js";
import { resolveContainerClaudeToken } from "../claude-token-relay.js";
import { egressActive } from "../../runtimes/container/egress-hook.js";
import { corePlaceholder, mintPlaceholder, PLACEHOLDER_SHAPES } from "./placeholders.js";
import { RELAY_RULE, RELAY_SECRET_NAME, rulesFor } from "./catalog-rules.js";

export const GRANT_SCOPES = Object.freeze(["organization", "channel", "personal", "relay"]);
const MINT_SCOPE = { organization: "org", channel: "channel", personal: "personal", relay: "relay" };
export const RELAY_CACHE_MS = 60_000;
export const MATERIAL_CACHE_MS = 5_000;

function keyFor({ scope, channelId = "", ownerId = "", secretName }) {
  if (!GRANT_SCOPES.includes(scope)) throw new Error(`unknown egress grant scope: ${scope}`);
  const name = String(secretName || "");
  if (!name) throw new Error("an egress grant needs a secret name");
  return {
    scope,
    // The organization's placeholder is shared by every channel; everything else is bound to one.
    channelId: scope === "organization" ? "" : String(channelId || ""),
    ownerId: scope === "personal" ? String(ownerId || "") : "",
    secretName: name,
  };
}

function rowOut(row) {
  if (!row) return null;
  return {
    placeholder: row.placeholder,
    scope: row.scope,
    channelId: row.channel_id,
    ownerId: row.owner_id,
    secretName: row.secret_name,
    createdMs: row.created_ms,
    revokedMs: row.revoked_ms,
  };
}

// Upsert-or-return the LIVE placeholder for this key. Concurrent callers converge on one row: the
// partial unique index refuses a second live row, and the loser re-reads the winner's.
export function placeholderFor({ scope, channelId = "", ownerId = "", secretName, now = Date.now() }) {
  const key = keyFor({ scope, channelId, ownerId, secretName });
  if (key.scope !== "organization" && !key.channelId) throw new Error(`a ${key.scope} egress grant needs a channel`);
  if (key.scope === "personal" && !key.ownerId) throw new Error("a personal egress grant needs an owner");
  const db = getDb();
  const find = () => db.prepare(
    "SELECT placeholder FROM egress_grants WHERE scope = ? AND channel_id = ? AND owner_id = ? AND secret_name = ? AND revoked_ms = 0",
  ).get(key.scope, key.channelId, key.ownerId, key.secretName);
  const existing = find();
  if (existing) return existing.placeholder;
  const placeholder = mintPlaceholder({ scope: MINT_SCOPE[key.scope] });
  try {
    db.prepare(
      "INSERT INTO egress_grants(placeholder, scope, channel_id, owner_id, secret_name, created_ms) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(placeholder, key.scope, key.channelId, key.ownerId, key.secretName, Number(now) || Date.now());
    return placeholder;
  } catch (error) {
    const raced = find();
    if (raced) return raced.placeholder;
    throw error;
  }
}

// The row a CORE placeholder names, or null (unknown, or revoked).
export function lookupGrant(placeholder) {
  const core = corePlaceholder(placeholder);
  if (!core) return null;
  const row = getDb().prepare("SELECT * FROM egress_grants WHERE placeholder = ?").get(core);
  return row && !row.revoked_ms ? rowOut(row) : null;
}

// Every live grant matching the filter (tests, reconcile, the status surface).
export function listGrants({ scope = "", channelId = null, ownerId = null } = {}) {
  const where = ["revoked_ms = 0"];
  const args = [];
  if (scope) { where.push("scope = ?"); args.push(scope); }
  if (channelId !== null && channelId !== undefined) { where.push("channel_id = ?"); args.push(String(channelId)); }
  if (ownerId !== null && ownerId !== undefined) { where.push("owner_id = ?"); args.push(String(ownerId)); }
  return getDb().prepare(`SELECT * FROM egress_grants WHERE ${where.join(" AND ")} ORDER BY created_ms`).all(...args).map(rowOut);
}

const materialCache = new Map(); // placeholder → { at, value, entry }

// Revoke every live grant matching the filter. Returns how many were revoked.
export function revokeGrants({ scope, channelId, ownerId, secretName, now = Date.now() } = {}) {
  if (!GRANT_SCOPES.includes(scope)) throw new Error(`unknown egress grant scope: ${scope}`);
  const where = ["scope = ?", "revoked_ms = 0"];
  const args = [scope];
  if (channelId !== undefined && channelId !== null) { where.push("channel_id = ?"); args.push(String(channelId)); }
  if (ownerId !== undefined && ownerId !== null) { where.push("owner_id = ?"); args.push(String(ownerId)); }
  if (secretName !== undefined && secretName !== null) { where.push("secret_name = ?"); args.push(String(secretName)); }
  const rows = getDb().prepare(`SELECT placeholder FROM egress_grants WHERE ${where.join(" AND ")}`).all(...args);
  if (!rows.length) return 0;
  const update = getDb().prepare("UPDATE egress_grants SET revoked_ms = ? WHERE placeholder = ? AND revoked_ms = 0");
  for (const { placeholder } of rows) {
    update.run(Number(now) || Date.now(), placeholder);
    materialCache.delete(placeholder);
  }
  return rows.length;
}

// Revoke the live grants of one scope whose secret NAME is no longer in `present`. The reconcile
// half of "removing a secret revokes its placeholder": called from the config-change listener
// (every in-process write) and at every run's own resolve.
export function revokeMissing({ scope, channelId, ownerId, present, now = Date.now() }) {
  const keep = present instanceof Set ? present : new Set(present || []);
  let revoked = 0;
  for (const grant of listGrants({ scope, channelId, ownerId })) {
    if (keep.has(grant.secretName)) continue;
    revoked += revokeGrants({ scope, channelId: grant.channelId, ownerId: grant.ownerId, secretName: grant.secretName, now });
  }
  return revoked;
}

// ── Live values ───────────────────────────────────────────────────────────────────────────────

let relayCache = null; // { at, promise }
async function cachedRelayToken(deps) {
  const now = Date.now();
  if (!relayCache || now - relayCache.at > RELAY_CACHE_MS) {
    relayCache = { at: now, promise: Promise.resolve().then(() => (deps.relayToken || resolveContainerClaudeToken)()) };
    relayCache.promise.catch(() => { relayCache = null; });
  }
  const relay = await relayCache.promise;
  return String(relay?.token || "");
}

export function __resetGrantCaches() {
  relayCache = null;
  materialCache.clear();
}

async function channelMetaFor(channelId, deps) {
  if (deps.metaFor) return (await deps.metaFor(channelId)) || null;
  const entry = await getChannelEntry(channelId);
  return entry?.slug ? (await getChannelMeta(entry.slug)) || null : null;
}

// → { value, entry, exists } for one grant row: the CURRENT real value and the stored entry its
// rules come from. `exists` false means the secret itself is gone (the caller revokes).
export async function resolveGrantMaterial(row, deps = {}) {
  const name = row.secretName;
  if (row.scope === "relay") return { value: await cachedRelayToken(deps), entry: null, exists: true };
  if (row.scope === "organization") {
    const entry = (deps.orgEntries ? deps.orgEntries() : getOrgEnv())[name] || null;
    const values = await (deps.resolveOrgEnv || resolveOrgEnv)();
    return { value: String(values[name] || ""), entry, exists: Boolean(entry) };
  }
  if (row.scope === "channel") {
    const meta = await channelMetaFor(row.channelId, deps);
    const entry = normalizeChannelEnv(meta?.env)[name] || null;
    const values = meta ? await (deps.resolveChannelEnv || resolveChannelEnv)(meta) : {};
    return { value: String(values[name] || ""), entry, exists: Boolean(entry) };
  }
  if (row.scope === "personal") {
    const entry = (await (deps.userEntries || getUserEnv)(row.ownerId))[name] || null;
    const values = await (deps.resolveUserEnv || resolveUserEnv)(row.ownerId);
    return { value: String(values[name] || ""), entry, exists: Boolean(entry) };
  }
  return { value: "", entry: null, exists: false };
}

// The spec's name for the value half: "" when the secret no longer exists.
export async function resolveGrantValue(row, deps = {}) {
  return (await resolveGrantMaterial(row, deps)).value;
}

// The proxy's resolveGrant callback: a CORE placeholder → the grant object the swap rules read
// ({ placeholder, value, secretName, scope, owner, channelId, hosts, headers, format }), or null.
// A secret whose entry is gone is revoked here too (a write the change listener did not see —
// the host-backend MCP child writes through its own database connection).
export async function resolveEgressGrant(core, deps = {}) {
  const row = lookupGrant(core);
  if (!row) return null;
  const now = Date.now();
  let material = materialCache.get(row.placeholder);
  if (!material || now - material.at > MATERIAL_CACHE_MS) {
    material = { at: now, ...(await resolveGrantMaterial(row, deps)) };
    materialCache.set(row.placeholder, material);
  }
  if (!material.exists) {
    revokeGrants({ scope: row.scope, channelId: row.channelId, ownerId: row.ownerId, secretName: row.secretName });
    return null;
  }
  const rule = row.scope === "relay" ? RELAY_RULE : rulesFor(row.secretName, material.entry);
  if (!rule || !material.value) return null;
  return {
    placeholder: row.placeholder,
    value: material.value,
    secretName: row.secretName,
    scope: row.scope,
    owner: row.ownerId || null,
    channelId: row.channelId,
    hosts: [...rule.hosts],
    headers: [...rule.headers],
    format: Array.isArray(rule.format) ? [...rule.format] : rule.format,
  };
}

// ── The spawn-site wrapper ────────────────────────────────────────────────────────────────────

function strictSetting(target) {
  if (typeof target?.settings?.egressSecretsStrict === "boolean") return target.settings.egressSecretsStrict;
  try { return getContainerRuntime().egressSecretsStrict === true; } catch { return false; }
}

// Resolve a spawn's environment secrets for its runtime target. Not isolated, or egress not
// active → exactly resolveRunEnv()'s answer (real values), with empty egress facts. Active → every
// name WITH a swap rule becomes its placeholder; a name WITHOUT one keeps its real value and is
// listed `unprotected` — unless the gateway's egressSecretsStrict is on, when it is dropped and
// listed `withheld`. `realValues` is every real value that exists, for the output redactor (the
// container should never see one, and a reply must never carry one either way).
export async function resolveEgressRunEnv({ meta = {}, channelId = "", authorId = "", untrustedPrincipal = false, clean = false, target = null, deps = {} } = {}) {
  const empty = { env: {}, scopes: {}, placeholders: {}, hosts: {}, unprotected: [], withheld: [], realValues: [] };
  if (clean) return empty;
  const [org, user, channel] = await Promise.all([
    (deps.resolveOrgEnv || resolveOrgEnv)(),
    (deps.resolveUserEnv || resolveUserEnv)(authorId, { untrustedPrincipal }),
    (deps.resolveChannelEnv || resolveChannelEnv)(meta),
  ]);
  const merged = mergeRunEnv({ org, user, channel });
  const real = safeSpawnEnv(merged.env);
  const realValues = [...new Set([...Object.values(safeSpawnEnv(org)), ...Object.values(safeSpawnEnv(user)), ...Object.values(safeSpawnEnv(channel))])];
  if (!egressActive(target)) {
    return { env: merged.env, scopes: merged.scopes, placeholders: {}, hosts: {}, unprotected: [], withheld: [], realValues };
  }
  const channelKey = String(channelId || meta?.channelId || "");
  const personalOwner = untrustedPrincipal ? "" : String(authorId || "");
  const entries = {
    organization: deps.orgEntries ? deps.orgEntries() : getOrgEnv(),
    personal: personalOwner ? await (deps.userEntries || getUserEnv)(personalOwner) : {},
    channel: normalizeChannelEnv(meta?.env),
  };
  // Reconcile first: a secret REMOVED since the last run loses its placeholder now, even if the
  // change listener never saw the write. Keyed by the STORED entry names, never by what resolved: a
  // secret that briefly resolves empty (a provider hiccup) is still a secret, and revoking it would
  // mint a new placeholder while warm processes hold the old, now dead, one.
  revokeMissing({ scope: "organization", present: Object.keys(entries.organization) });
  if (channelKey) revokeMissing({ scope: "channel", channelId: channelKey, present: Object.keys(entries.channel) });
  if (channelKey && personalOwner) revokeMissing({ scope: "personal", channelId: channelKey, ownerId: personalOwner, present: Object.keys(entries.personal) });

  const strict = strictSetting(target);
  const env = {};
  const scopes = {};
  const placeholders = {};
  const hosts = {};
  const unprotected = [];
  const withheld = [];
  for (const name of Object.keys(real).sort()) {
    const scope = merged.scopes[name];
    const rule = rulesFor(name, entries[scope]?.[name] || null);
    const bindable = scope === "organization" || (channelKey && (scope !== "personal" || personalOwner));
    if (rule && bindable) {
      const placeholder = placeholderFor({ scope, channelId: channelKey, ownerId: personalOwner, secretName: name });
      env[name] = placeholder;
      scopes[name] = scope;
      placeholders[name] = placeholder;
      hosts[name] = [...rule.hosts];
      continue;
    }
    if (strict) {
      withheld.push(name);
      continue;
    }
    env[name] = real[name];
    scopes[name] = scope;
    unprotected.push(name);
  }
  return { env, scopes, placeholders, hosts, unprotected, withheld, realValues };
}

// ── The Claude relay ──────────────────────────────────────────────────────────────────────────

export function relayPlaceholderFor({ channelId }) {
  return placeholderFor({ scope: "relay", channelId, secretName: RELAY_SECRET_NAME });
}

// What a containerized Claude receives in CLAUDE_CODE_OAUTH_TOKEN. Egress active and a relay token
// to stand for → the channel's relay placeholder, in the Anthropic OAuth token SHAPE (the grant is
// keyed by the core `cgph_…`; the proxy matches the shaped token as one), with the relay's source
// and expiry kept so the warm-pool fingerprint still retires a process when the login refreshes.
// Otherwise the real relay, unchanged.
export function containerClaudeCredential({ target, relay, channelId = "" }) {
  if (!relay || !relay.token || !egressActive(target)) return relay;
  const key = String(channelId || target?.meta?.channelId || "");
  if (!key) return relay;
  const placeholder = relayPlaceholderFor({ channelId: key });
  return { ...relay, token: `${PLACEHOLDER_SHAPES["anthropic-oauth"]}${placeholder}`, placeholder: true };
}
