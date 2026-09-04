// User admin routes: the masked user list and per-user save (approval/admin flags + write-only
// personal tokens). Split from admin.js; mounted by createAdminRouter so every URL is unchanged.
import { Router } from "express";
import { getUsers, setUser } from "../../config/store.js";
import { cleanAccessGrants } from "./helpers.js";

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

export function createUsersRouter() {
  const router = Router();

  // ── Users ─────────────────────────────────────────────────────────────────
  router.get("/users", async (_req, res, next) => {
    try {
      res.json({ users: maskUsers(await getUsers()) });
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
