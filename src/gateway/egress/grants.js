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
// channel → c, thread → c (distinct database scope, owner is the thread key), personal → p (per channel AND author: another author's turn never receives it),
// relay → r (an engine login relay, per channel: the Claude access token `CLAUDE_CODE_OAUTH_TOKEN`,
// and its Codex twin `CODEX_ACCESS_TOKEN` — codex-token-relay.js — keyed by secret name).
import { getDb } from "../../db/index.js";
import { getChannelEntry, getChannelMeta, getChannelsIndex } from "../../config/store.js";
import { platformOr } from "../../platforms/registry.js";
import { normalizeChannelEnv, resolveChannelEnv, safeSpawnEnv } from "../../config/channel-env.js";
import { getOrgEnv, getUserEnv, mergeRunEnv, resolveOrgEnv, resolveUserEnv } from "../../config/scoped-env.js";
import { getContainerRuntime } from "../../config/settings.js";
import { resolveContainerClaudeToken } from "../claude-token-relay.js";
import { renderContainerCodexApiAuth, renderContainerCodexAuth, resolveContainerCodexToken } from "../codex-token-relay.js";
import { codexLoginCandidatesFor } from "../channel-codex-auth.js";
import { egressActive } from "../../runtimes/container/egress-hook.js";
import { corePlaceholder, mintPlaceholder, PLACEHOLDER_SHAPES, wrapPlaceholder } from "./placeholders.js";
import { CLAUDE_API_RELAY_NAMES, CODEX_API_RELAY_SECRET_NAME, CODEX_RELAY_SECRET_NAME, RELAY_SECRET_NAME, relayRuleFor, rulesFor } from "./catalog-rules.js";
import { engineHostsFor } from "./engine-hosts.js";

export const GRANT_SCOPES = Object.freeze(["organization", "channel", "thread", "personal", "relay"]);
const MINT_SCOPE = { organization: "org", channel: "channel", thread: "channel", personal: "personal", relay: "relay" };
export const RELAY_CACHE_MS = 60_000;
export const MATERIAL_CACHE_MS = 5_000;

// A key configured for a custom Anthropic-compatible gateway must never be repurposed for the
// real Anthropic API. Its ordinary main-process environment keeps that custom destination.
function hasCanonicalClaudeApiEndpoint(env) {
  const base = String(env?.ANTHROPIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return !base || base === "https://api.anthropic.com";
}

function keyFor({ scope, channelId = "", ownerId = "", secretName }) {
  if (!GRANT_SCOPES.includes(scope)) throw new Error(`unknown egress grant scope: ${scope}`);
  const name = String(secretName || "");
  if (!name) throw new Error("an egress grant needs a secret name");
  return {
    scope,
    // The organization's placeholder is shared by every channel; everything else is bound to one.
    channelId: scope === "organization" ? "" : String(channelId || ""),
    ownerId: ["personal", "thread"].includes(scope) ? String(ownerId || "") : "",
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
  if (["personal", "thread"].includes(key.scope) && !key.ownerId) throw new Error(`a ${key.scope} egress grant needs an owner`);
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

// One cache per relay (secret name): the live token behind the channel placeholders, resolved —
// and refreshed when it is about to expire — at most once a minute.
const relayCaches = new Map(); // secret name → { at, promise }
async function cachedRelayToken(secretName, deps, channelId = "") {
  const codexSecret = secretName === CODEX_RELAY_SECRET_NAME || secretName === CODEX_API_RELAY_SECRET_NAME;
  const resolve = codexSecret
    ? (deps.codexRelayToken || resolveContainerCodexToken)
    : (deps.relayToken || resolveContainerClaudeToken);
  const now = Date.now();
  const meta = codexSecret ? await channelMetaFor(channelId, deps) : null;
  const cacheKey = codexSecret ? `${secretName}:${channelId}:${meta?.codexAuthSource || "gateway"}` : secretName;
  let cache = relayCaches.get(cacheKey);
  if (!cache || now - cache.at > RELAY_CACHE_MS) {
    cache = { at: now, promise: Promise.resolve().then(async () => {
      if (!codexSecret) return resolve();
      const token = await resolve({ candidates: codexLoginCandidatesFor(meta) });
      return token?.source === (secretName === CODEX_API_RELAY_SECRET_NAME ? "api-key" : "chatgpt") ? token : { token: "" };
    }) };
    relayCaches.set(cacheKey, cache);
    cache.promise.catch(() => { if (relayCaches.get(cacheKey) === cache) relayCaches.delete(cacheKey); });
  }
  const relay = await cache.promise;
  return String(relay?.token || "");
}

export function __resetGrantCaches() {
  relayCaches.clear();
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
  if (row.scope === "relay") {
    if (!relayRuleFor(name)) return { value: "", entry: null, exists: false };
    if (CLAUDE_API_RELAY_NAMES.includes(name)) {
      const env = deps.env || process.env;
      const value = hasCanonicalClaudeApiEndpoint(env) ? String(env[name] || "") : "";
      return { value, entry: null, exists: Boolean(value) };
    }
    return { value: await cachedRelayToken(name, deps, row.channelId), entry: null, exists: true };
  }
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
  if (row.scope === "thread") {
    const meta = await channelMetaFor(row.channelId, deps);
    const entry = await getChannelEntry(row.channelId);
    const slug = String(meta?.slug || entry?.slug || "");
    const settings = deps.threadSettings
      ? await deps.threadSettings(row.channelId, row.ownerId)
      : slug ? (await import("../thread-settings.js")).getThreadSettings(slug, row.ownerId, "secrets") : {};
    const entries = normalizeChannelEnv(settings?.env);
    const values = await (deps.resolveChannelEnv || resolveChannelEnv)({ ...meta, env: entries });
    return { value: String(values[name] || ""), entry: entries[name] || null, exists: Boolean(entries[name]) };
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
  if (["relay", "thread"].includes(row.scope) || !material || now - material.at > MATERIAL_CACHE_MS) {
    material = { at: now, ...(await resolveGrantMaterial(row, deps)) };
    materialCache.set(row.placeholder, material);
  }
  // A removal can commit while a provider resolves. Never resurrect a revoked row.
  if (!lookupGrant(row.placeholder)) return null;
  if (!material.exists) {
    revokeGrants({ scope: row.scope, channelId: row.channelId, ownerId: row.ownerId, secretName: row.secretName });
    return null;
  }
  const rule = row.scope === "relay" ? relayRuleFor(row.secretName) : rulesFor(row.secretName, material.entry, { value: material.value });
  if (!rule || !material.value) return null;
  return {
    ...(rule.approval ? { approval: true, neverHosts: engineHostsFor() } : {}),
    ...(rule.credentialFields ? { credentialFields: true, neverHosts: engineHostsFor() } : {}),
    ...(Array.isArray(rule.query) ? { query: [...rule.query] } : {}),
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
  // Unreadable settings fail closed (strict): withholding a secret is recoverable, leaking it is not.
  try { return getContainerRuntime().egressSecretsStrict !== false; } catch { return true; }
}

// Resolve a spawn's environment secrets for its runtime target. Not isolated, or egress not
// active → exactly resolveRunEnv()'s answer (real values), with empty egress facts. Active → every
// name WITH a swap rule becomes its placeholder; a name WITHOUT one keeps its real value and is
// listed `unprotected` — unless the gateway's egressSecretsStrict is on, when it is dropped and
// listed `withheld`. `realValues` is every real value that exists, for the output redactor (the
// container should never see one, and a reply must never carry one either way).
// `personalPaused` is true when the author holds personal PLACEHOLDERS that the proxy will refuse
// right now because a DIFFERENT person has an SSH session open in the channel (liveness.js) — the
// per-attempt credential note says so instead of letting the agent chase a 403. A snapshot at
// resolve time: the proxy re-checks on every request.
export async function resolveEgressRunEnv({ meta = {}, channelId = "", authorId = "", untrustedPrincipal = false, clean = false, target = null, deps = {} } = {}) {
  const empty = { env: {}, scopes: {}, placeholders: {}, hosts: {}, unprotected: [], withheld: [], approval: [], realValues: [], personalPaused: false };
  if (clean) return empty;
  const threadEntries = normalizeChannelEnv(meta?.threadEnv);
  const threadKey = String(meta?.threadSettingsKey || "");
  if (Object.keys(threadEntries).length && !threadKey) throw new Error("Thread secrets need a bound thread key.");
  const [org, user, channel, thread] = await Promise.all([
    (deps.resolveOrgEnv || resolveOrgEnv)(),
    (deps.resolveUserEnv || resolveUserEnv)(authorId, { untrustedPrincipal }),
    (deps.resolveChannelEnv || resolveChannelEnv)(meta),
    (deps.resolveChannelEnv || resolveChannelEnv)({ ...meta, env: threadEntries }),
  ]);
  // Removing an inherited channel entry is a thread-only override. It never deletes the
  // channel entry or the author/organization fallback.
  for (const name of meta?.threadEnvRemoved || []) delete channel[name];
  const merged = mergeRunEnv({ org, user, channel });
  for (const [name, value] of Object.entries(thread)) {
    if (typeof value !== "string" || !value) continue;
    merged.env[name] = value;
    merged.scopes[name] = "thread";
  }
  const real = safeSpawnEnv(merged.env);
  const realValues = [...new Set([...Object.values(safeSpawnEnv(org)), ...Object.values(safeSpawnEnv(user)), ...Object.values(safeSpawnEnv(channel)), ...Object.values(safeSpawnEnv(thread))])];
  if (!egressActive(target)) {
    return { env: merged.env, scopes: merged.scopes, placeholders: {}, hosts: {}, unprotected: [], withheld: [], approval: [], realValues, personalPaused: false };
  }
  const channelKey = String(channelId || meta?.channelId || "");
  const personalOwner = untrustedPrincipal ? "" : String(authorId || "");
  const entries = {
    organization: deps.orgEntries ? deps.orgEntries() : getOrgEnv(),
    personal: personalOwner ? await (deps.userEntries || getUserEnv)(personalOwner) : {},
    channel: normalizeChannelEnv(meta?.env),
    thread: threadEntries,
  };
  // Reconcile first: a secret REMOVED since the last run loses its placeholder now, even if the
  // change listener never saw the write. Keyed by the STORED entry names, never by what resolved: a
  // secret that briefly resolves empty (a provider hiccup) is still a secret, and revoking it would
  // mint a new placeholder while warm processes hold the old, now dead, one.
  revokeMissing({ scope: "organization", present: Object.keys(entries.organization) });
  if (channelKey) revokeMissing({ scope: "channel", channelId: channelKey, present: Object.keys(entries.channel) });
  if (channelKey && personalOwner) revokeMissing({ scope: "personal", channelId: channelKey, ownerId: personalOwner, present: Object.keys(entries.personal) });

  if (channelKey && threadKey) revokeMissing({ scope: "thread", channelId: channelKey, ownerId: threadKey, present: Object.keys(entries.thread) });

  const strict = strictSetting(target);
  const env = {};
  const scopes = {};
  const placeholders = {};
  const hosts = {};
  const unprotected = [];
  const withheld = [];
  // Hidden secrets with no known destination (catalog-rules.js approval rules): placeholders whose
  // first use on each new server needs an admin's approval. Named in the per-attempt note.
  const approval = [];
  for (const name of Object.keys(real).sort()) {
    const scope = merged.scopes[name];
    const rule = rulesFor(name, entries[scope]?.[name] || null, { value: real[name] });
    const bindable = scope === "organization" || (channelKey && (scope !== "personal" || personalOwner) && (scope !== "thread" || threadKey));
    if (rule && bindable) {
      const placeholder = placeholderFor({ scope, channelId: channelKey, ownerId: scope === "thread" ? threadKey : personalOwner, secretName: name });
      env[name] = placeholder;
      scopes[name] = scope;
      placeholders[name] = placeholder;
      hosts[name] = [...rule.hosts];
      if (rule.approval) approval.push(name);
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
  let personalPaused = false;
  if (channelKey && personalOwner && Object.keys(placeholders).some((name) => scopes[name] === "personal")) {
    // Imported lazily: liveness.js reads the SSH broker, whose import graph reaches back here.
    // Paused for the same two reasons the proxy refuses (service.js canUseGrant): another person's
    // SSH session, or another author's live turn or job in this channel.
    const liveness = await import("./liveness.js");
    const otherSshOpen = deps.otherSshOpen || liveness.otherSshOpen;
    const otherOwnerActive = deps.otherOwnerActive || liveness.otherOwnerActive;
    personalPaused = Boolean(otherSshOpen(channelKey, personalOwner) || otherOwnerActive(channelKey, personalOwner));
  }
  return { env, scopes, placeholders, hosts, unprotected, withheld, approval, realValues, personalPaused };
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

// The durable nested-CLI login holds only channel-bound placeholders. An API-key installation
// gets the same protection as OAuth; never persist a daemon key or a raw legacy-bridge token.
export function nestedClaudeLoginEnv({ target, relay, channelId = "", env = process.env }) {
  const key = String(channelId || target?.meta?.channelId || "");
  if (!egressActive(target) || !key) return {};
  if (relay?.token) {
    return { CLAUDE_CODE_OAUTH_TOKEN: containerClaudeCredential({ target, relay, channelId: key }).token };
  }
  if (relay?.source !== "api-key" || !hasCanonicalClaudeApiEndpoint(env)) return {};
  return Object.fromEntries(CLAUDE_API_RELAY_NAMES.filter((name) => env[name]).map((name) => [name,
    placeholderFor({ scope: "relay", channelId: key, secretName: name }),
  ]));
}

// ── The Codex relay (the twin) ────────────────────────────────────────────────────────────────

// The channel id a target's grants bind to when its meta does not carry one (a legacy meta): the
// channels index, slug + platform → id — the same lookup the egress listener binds with, never a
// guess.
async function channelIdOfTarget(target) {
  const slug = String(target?.slug || "");
  if (!slug) return "";
  const platform = platformOr(target?.platform).id;
  const index = await getChannelsIndex();
  return Object.entries(index).find(([, entry]) => entry?.slug === slug && platformOr(entry?.platform).id === platform)?.[0] || "";
}

export function codexRelayPlaceholderFor({ channelId }) {
  return placeholderFor({ scope: "relay", channelId, secretName: CODEX_RELAY_SECRET_NAME });
}

export function codexApiRelayPlaceholderFor({ channelId }) {
  return placeholderFor({ scope: "relay", channelId, secretName: CODEX_API_RELAY_SECRET_NAME });
}

// What a containerized Codex reads as its sign-in: the body of the ACCESS-ONLY auth.json the
// runner writes into the channel's HOME volume (codex-token-relay.js renderContainerCodexAuth).
// Needs the proxy as this target's egress — with no swap, a placeholder cannot authenticate, and
// the legacy bridge mode keeps the shared-file mount instead. → { authJson, expiresAt, placeholder,
// source } or { error } when there is nothing to relay. Never returns a real token.
export async function containerCodexCredential({ target, channelId = "", resolveRelay = resolveContainerCodexToken, now = Date.now } = {}) {
  if (!egressActive(target)) return { error: "the egress proxy is not this container's network, so Codex cannot use a relayed sign-in" };
  const key = String(channelId || target?.meta?.channelId || "") || (await channelIdOfTarget(target));
  if (!key) return { error: "the run has no channel to bind Codex's relayed sign-in to" };
  const relay = await resolveRelay({ candidates: codexLoginCandidatesFor(target?.meta) });
  if (!relay?.token) return { error: relay?.error || "the gateway has no Codex sign-in to relay", source: relay?.source || "none" };
  if (relay.source === "api-key") {
    return {
      authJson: renderContainerCodexApiAuth({ apiKey: codexApiRelayPlaceholderFor({ channelId: key }) }),
      expiresAt: 0,
      source: "api-key",
      placeholder: true,
    };
  }
  const accessToken = wrapPlaceholder(codexRelayPlaceholderFor({ channelId: key }), { shape: "jwt", claimsFrom: relay.token });
  return {
    authJson: renderContainerCodexAuth({ accessToken, idToken: relay.idToken, accountId: relay.accountId, now }),
    expiresAt: relay.expiresAt || 0,
    source: relay.source,
    placeholder: true,
  };
}
