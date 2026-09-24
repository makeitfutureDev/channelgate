// Environment secrets that are NOT the channel's: the ORGANIZATION's and a PERSON's.
//
// config/channel-env.js answers "this conversation's own CLI logins". Two scopes were missing
// either side of it, and both were being faked with a per-channel copy of the same token:
//
//   • ORGANIZATION — one credential the whole deployment shares (the GitHub token every channel
//     needs to push, the company npm token). Copying it into every channel meant N places to
//     rotate and N places to forget; a channel created tomorrow silently had no access at all.
//   • PERSON — a credential that belongs to the human, not to any room. It is injected only into
//     runs that PERSON authored, so their key is never handed to a turn someone else started in
//     the same channel.
//
// Everything about names, values, masking, providers and resolution is channel-env.js's, reused
// verbatim: one validation story for all three scopes (a second one is how a reserved name
// eventually gets through). Only the STORAGE differs, because the three records differ:
//   • organization → settings.json `orgEnv` (already 0600, already where the org Composio and
//     run-API secrets live, and NOT in config/settings.js's ENV_MAP, so it can never be copied
//     into the daemon's own process.env).
//   • person      → the `users` row's JSON blob (`data.env`), beside composioToken/toolboxToken,
//     the personal credentials that were already there.
//
// PRECEDENCE at spawn is organization → person → channel, most specific last (mergeRunEnv). The
// channel deliberately outranks the person: the channel's secrets ARE its project identity, and a
// personal token silently answering for the room's account is the substitution the Composio
// identity rules exist to prevent. A person's secret therefore FILLS a gap the channel does not
// define; it never redirects one the channel does. The preamble names which scope each variable
// came from (gateway/channel-credentials.js) so the agent can say which account it used.
import { getSettings, saveSettings } from "./settings.js";
import { getUser, setUser } from "./store.js";
import { listEnvVars, normalizeChannelEnv, patchChannelEnv, resolveChannelEnv, resolveEnvMap } from "./channel-env.js";
import { emitConfigChange } from "./change-events.js";

// ── Organization ──────────────────────────────────────────────────────────────────────────────

export function getOrgEnv() {
  return normalizeChannelEnv(getSettings().orgEnv);
}

export function listOrgEnv() {
  return listEnvVars(getOrgEnv());
}

// One mutation entry point per scope, mirroring patchChannelEnv — the admin API and the MCP tool
// must not grow two different validation stories.
export function patchOrgEnv({ set = null, remove = "", actor = "", now = Date.now() } = {}) {
  const next = patchChannelEnv(getOrgEnv(), {
    set, remove, actor, now,
    scopeNoun: "The organization", scopeWhere: "the organization",
  });
  saveSettings({ orgEnv: next });
  emitConfigChange("org-env", {});
  return listEnvVars(next);
}

export async function resolveOrgEnv() {
  return resolveEnvMap(getOrgEnv(), { scopeLabel: "Organization" });
}

// ── Person ────────────────────────────────────────────────────────────────────────────────────

export async function getUserEnv(userId) {
  if (!userId) return {};
  return normalizeChannelEnv((await getUser(userId))?.env);
}

export async function listUserEnv(userId) {
  return listEnvVars(await getUserEnv(userId));
}

// `actor` defaults to the person themselves (the chat tools), and is passed explicitly by the
// admin UI, which authenticates one shared password and has no per-person identity to claim.
export async function patchUserEnv(userId, { set = null, remove = "", actor = "", now = Date.now() } = {}) {
  if (!userId) throw new Error("No user to change.");
  const next = patchChannelEnv(await getUserEnv(userId), {
    set, remove, actor: actor || userId, now,
    scopeNoun: "You", scopeWhere: "your account",
  });
  await setUser(userId, { env: next });
  return listEnvVars(next);
}

// A person's secrets are only ever resolved for a principal the platform AUTHENTICATED. The HTTP
// run API authenticates its key, not the `author` it names, so an untrusted caller gets nothing
// here — the same rule that already withholds the personal Composio and Toolbox tokens
// (gateway/access-grants.js). Passing the flag in rather than reading it back keeps one source.
export async function resolveUserEnv(userId, { untrustedPrincipal = false } = {}) {
  if (!userId || untrustedPrincipal) return {};
  return resolveEnvMap(await getUserEnv(userId), { scopeLabel: "Personal" });
}

// ── The spawn-time merge ──────────────────────────────────────────────────────────────────────

// Later wins: organization → person → channel. Returns BOTH the merged map the runners receive
// and, per surviving name, the scope that supplied it — the preamble needs the second half, and
// deriving it later from three maps is exactly the kind of duplicate that drifts.
export function mergeRunEnv({ org = {}, user = {}, channel = {} } = {}) {
  const env = {};
  const scopes = {};
  for (const [scope, map] of [["organization", org], ["personal", user], ["channel", channel]]) {
    for (const [name, value] of Object.entries(map || {})) {
      if (typeof value !== "string" || !value) continue;
      env[name] = value;
      scopes[name] = scope;
    }
  }
  return { env, scopes };
}

// Resolve all three scopes for one spawn. Clean mode runs bare — no MCP servers, no Composio
// tokens, no skills — and that has to include every credential scope, not just the channel's.
export async function resolveRunEnv({ meta = {}, authorId = "", untrustedPrincipal = false, clean = false } = {}) {
  if (clean) return { env: {}, scopes: {} };
  const [org, user, channel] = await Promise.all([
    resolveOrgEnv(),
    resolveUserEnv(authorId, { untrustedPrincipal }),
    resolveChannelEnv(meta),
  ]);
  return mergeRunEnv({ org, user, channel });
}
