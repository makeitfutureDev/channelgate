// User admin routes: the masked user list and per-user save (approval/admin flags, personal
// preferences, and write-only tokens). Split from admin.js; mounted by createAdminRouter so every
// URL is unchanged.
import { Router } from "express";
import { getUsers, setUser } from "../../config/store.js";
import { getDefaultNudges, userNudgesEnabled } from "../../config/settings.js";
import { logEvent } from "../../util/logger.js";
import { cleanAccessGrants } from "./helpers.js";
import { revokeRemoteMcpsForAuthor } from "../../mcp/remote-mcp-registry.js";
// A person's OWN environment secrets (config/scoped-env.js). Same write-only contract as a
// channel's: listUserEnv's masked shape is the only thing that may leave the process.
import { listUserEnv, patchUserEnv } from "../../config/scoped-env.js";
import { listEnvVars, normalizeEnvName, swapRuleFieldsFrom } from "../../config/channel-env.js";

// The user listing is built field by field, never `...u`. That is the property that matters here:
// a stored user record can carry secrets this file has never heard of — a personal token from an
// integration that has since been retired — and only an explicit allowlist keeps those out of the
// response. Add a field here on purpose or it does not ship. (See config/dead-fields.js for the
// other half: the retired fields are also removed from the stored records.)
// The admin UI authenticates ONE shared admin password, so there is no per-person identity to
// attribute a write to. Say that plainly rather than inventing a name.
const USER_SECRET_ACTOR = "admin UI";

function maskUsers(users) {
  const out = {};
  for (const [id, u] of Object.entries(users)) {
    const token = u.composioToken || "";
    const toolbox = u.toolboxToken || "";
    out[id] = {
      name: u.name || "",
      isAdmin: Boolean(u.isAdmin),
      approved: Boolean(u.approved),
      nudges: userNudgesEnabled(u),
      hasComposioToken: Boolean(token),
      composioTokenLast4: token ? token.slice(-4) : "",
      composioTokenLabel: u.composioTokenLabel || "",
      hasToolboxToken: Boolean(toolbox),
      toolboxTokenLast4: toolbox ? toolbox.slice(-4) : "",
      toolboxTokenLabel: u.toolboxTokenLabel || "",
      // Names + last4 only, like every other secret surface. Listing them here is what makes the
      // scope administrable at all: nobody but the person can see them from chat.
      secrets: listEnvVars(u.env),
      ...cleanAccessGrants(u),
    };
  }
  return out;
}

function foldSearch(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}

// Search only the already-masked representation. Besides keeping retired/unknown secret fields
// out of the index, this makes the searchable vocabulary exactly match what the table can show:
// identity, its one visible role, and which token-provider dots are filled.
export function filterUsersForSearch(users, query) {
  const terms = foldSearch(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return users;

  return Object.fromEntries(Object.entries(users).filter(([id, user]) => {
    const role = user.isAdmin ? "admin" : user.approved ? "approved" : "no access";
    const tokens = [
      user.hasComposioToken ? "composio c token configured set" : "",
      user.hasToolboxToken ? "toolbox t token configured set" : "",
      !user.hasComposioToken && !user.hasToolboxToken ? "no tokens" : "",
    ];
    const reminders = user.nudges ? "reminders on enabled" : "reminders off disabled";
    const haystack = foldSearch([user.name, id, role, reminders, ...tokens].join(" "));
    return terms.every((term) => haystack.includes(term));
  }));
}

export function createUsersRouter() {
  const router = Router();

  // ── Users ─────────────────────────────────────────────────────────────────
  router.get("/users", async (req, res, next) => {
    try {
      const users = maskUsers(await getUsers());
      // Bound an otherwise harmless query so one request cannot make a needlessly giant search
      // string. Express may represent repeated query keys as an array; the first value wins.
      const rawQuery = Array.isArray(req.query.q) ? req.query.q[0] : req.query.q;
      const query = typeof rawQuery === "string" ? rawQuery.slice(0, 200) : "";
      res.json({ users: filterUsersForSearch(users, query) });
    } catch (e) {
      next(e);
    }
  });

  // Push the organization default onto every existing user. New users capture the same setting
  // at first sight; this bulk action intentionally replaces personal overrides.
  router.post("/users/reset-nudges", async (_req, res, next) => {
    try {
      const nudges = getDefaultNudges();
      const users = await getUsers();
      let reset = 0;
      for (const userId of Object.keys(users)) {
        await setUser(userId, { nudges });
        reset++;
      }
      await logEvent("users_nudges_reset", { count: reset, nudges });
      res.json({ ok: true, count: reset, nudges });
    } catch (error) {
      next(error);
    }
  });

  // ── One person's own environment secrets ────────────────────────────────────
  // Injected only into runs this person authored, in every conversation they talk in. Separate
  // routes rather than fields on the user PUT: a secret write is a single blind overwrite that
  // must not ride along with an unrelated profile save, and the audit line carries the NAME only.
  router.get("/users/:userId/env", async (req, res, next) => {
    try {
      res.json({ vars: await listUserEnv(req.params.userId) });
    } catch (e) {
      next(e);
    }
  });

  router.put("/users/:userId/env/:name", async (req, res, next) => {
    try {
      const { userId } = req.params;
      const value = typeof req.body?.value === "string" ? req.body.value : "";
      // The stored key is the canonical (uppercase) spelling, so the audit line names THAT; the
      // mutation still gets the raw name so a refusal quotes what the caller actually sent.
      const name = normalizeEnvName(req.params.name);
      let vars;
      try {
        vars = await patchUserEnv(userId, { set: { name: req.params.name, value, ...swapRuleFieldsFrom(req.body) }, actor: USER_SECRET_ACTOR });
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      logEvent("user_env_set", { user: userId, name, actor: USER_SECRET_ACTOR });
      res.json({ ok: true, vars });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/users/:userId/env/:name", async (req, res, next) => {
    try {
      const { userId } = req.params;
      const name = normalizeEnvName(req.params.name);
      let vars;
      try {
        vars = await patchUserEnv(userId, { remove: name });
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      logEvent("user_env_removed", { user: userId, name, actor: USER_SECRET_ACTOR });
      res.json({ ok: true, vars });
    } catch (e) {
      next(e);
    }
  });

  router.put("/users/:userId", async (req, res, next) => {
    try {
      const { userId } = req.params;
      const body = req.body ?? {};
      const patch = {};
      if (typeof body.name === "string") patch.name = body.name;
      if (typeof body.isAdmin === "boolean") patch.isAdmin = body.isAdmin;
      if (typeof body.approved === "boolean") patch.approved = body.approved;
      if (typeof body.nudges === "boolean") patch.nudges = body.nudges;
      // Only overwrite tokens when a non-empty value is sent (write-only fields).
      if (typeof body.composioToken === "string" && body.composioToken.length > 0)
        patch.composioToken = body.composioToken;
      if (body.clearComposioToken === true) patch.composioToken = "";
      if (typeof body.toolboxToken === "string" && body.toolboxToken.length > 0)
        patch.toolboxToken = body.toolboxToken;
      if (body.clearToolboxToken === true) patch.toolboxToken = "";
      // Owner labels (a note for the admin — whose account the token authenticates as). Not secret;
      // a plain string that always round-trips, with an empty string clearing it.
      if (typeof body.composioTokenLabel === "string") patch.composioTokenLabel = body.composioTokenLabel.trim();
      if (typeof body.toolboxTokenLabel === "string") patch.toolboxTokenLabel = body.toolboxTokenLabel.trim();
      if (body.accessGrants && typeof body.accessGrants === "object" && !Array.isArray(body.accessGrants))
        Object.assign(patch, cleanAccessGrants(body.accessGrants));

      const saved = await setUser(userId, patch);
      // The admin UI's "clear token" is the same revocation as clear_my_composio_token /
      // clear_my_toolbox_token: in-flight container relays for that person's runs stop now.
      if (patch.composioToken === "" || patch.toolboxToken === "") revokeRemoteMcpsForAuthor(userId);
      res.json({
        ok: true,
        user: {
          name: saved.name,
          isAdmin: saved.isAdmin,
          approved: saved.approved,
          nudges: userNudgesEnabled(saved),
          hasComposioToken: Boolean(saved.composioToken),
          hasToolboxToken: Boolean(saved.toolboxToken),
          ...cleanAccessGrants(saved),
        },
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
