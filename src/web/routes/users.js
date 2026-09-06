// User admin routes: the masked user list and per-user save (approval/admin flags + write-only
// personal tokens). Split from admin.js; mounted by createAdminRouter so every URL is unchanged.
import { Router } from "express";
import { getUsers, setUser } from "../../config/store.js";
import { cleanAccessGrants } from "./helpers.js";

// The user listing is built field by field, never `...u`. That is the property that matters here:
// a stored user record can carry secrets this file has never heard of — a personal token from an
// integration that has since been retired — and only an explicit allowlist keeps those out of the
// response. Add a field here on purpose or it does not ship. (See config/dead-fields.js for the
// other half: the retired fields are also removed from the stored records.)
function maskUsers(users) {
  const out = {};
  for (const [id, u] of Object.entries(users)) {
    const token = u.composioToken || "";
    const toolbox = u.toolboxToken || "";
    out[id] = {
      name: u.name || "",
      isAdmin: Boolean(u.isAdmin),
      approved: Boolean(u.approved),
      hasComposioToken: Boolean(token),
      composioTokenLast4: token ? token.slice(-4) : "",
      composioTokenLabel: u.composioTokenLabel || "",
      hasToolboxToken: Boolean(toolbox),
      toolboxTokenLast4: toolbox ? toolbox.slice(-4) : "",
      toolboxTokenLabel: u.toolboxTokenLabel || "",
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
    const haystack = foldSearch([user.name, id, role, ...tokens].join(" "));
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

  router.put("/users/:userId", async (req, res, next) => {
    try {
      const { userId } = req.params;
      const body = req.body ?? {};
      const patch = {};
      if (typeof body.name === "string") patch.name = body.name;
      if (typeof body.isAdmin === "boolean") patch.isAdmin = body.isAdmin;
      if (typeof body.approved === "boolean") patch.approved = body.approved;
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
      res.json({
        ok: true,
        user: {
          name: saved.name,
          isAdmin: saved.isAdmin,
          approved: saved.approved,
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
