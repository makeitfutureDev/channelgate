// Mounted behind the existing admin authentication and origin guard.
import { Router } from "express";
import { getUsers, getUser } from "../../config/store.js";
import { saveSettings } from "../../config/settings.js";
import { logEvent } from "../../util/logger.js";
import { autoApproveUser, eligibleForAutoApproval, getAutoApprovalPolicy,
  matchingApprovalDomain, normalizeApprovalDomains, slackIdentityEmail } from "../../gateway/user-auto-approval.js";

export function createUserAutoApprovalRouter({ slack } = {}) {
  const router = Router();
  router.get("/user-auto-approval", (_req, res) => res.json(getAutoApprovalPolicy()));
  router.put("/user-auto-approval", async (req, res, next) => {
    let domains;
    try {
      if (typeof req.body?.enabled !== "boolean") throw new TypeError("enabled must be a boolean.");
      domains = normalizeApprovalDomains(req.body.domains);
      if (req.body.enabled && !domains.length) throw new TypeError("Add a domain before enabling auto-approval.");
    } catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      saveSettings({ userAutoApprovalEnabled: req.body.enabled, userAutoApprovalDomains: domains });
      await logEvent("user_auto_approval_policy_changed", { actor: "admin UI", enabled: req.body.enabled, domains });
      res.json(getAutoApprovalPolicy());
    } catch (error) { next(error); }
  });

  // Only known users are considered. Fetch a fresh provider identity on BOTH preview and apply;
  // no editable/cached email becomes an authorization credential. Other platforms approve on
  // their next authenticated inbound event when an email is available.
  for (const action of ["preview", "apply"]) router.post(`/user-auto-approval/${action}`, async (req, res, next) => {
    const client = slack?.getClient?.();
    if (!client) return res.status(503).json({ error: "Connect Slack to preview existing users. Other platforms are checked on their next message." });
    if (!getAutoApprovalPolicy().enabled) return res.status(400).json({ error: "Save and enable the policy first." });
    try {
      const users = await getUsers();
      let ids = Object.keys(users).filter(id => /^[UW][A-Z0-9]+$/.test(id) && eligibleForAutoApproval(users[id]));
      if (action === "apply") {
        if (!Array.isArray(req.body?.userIds) || req.body.userIds.length > 500 || req.body.userIds.some(id => typeof id !== "string")) {
          return res.status(400).json({ error: "Provide at most 500 previewed user IDs." });
        }
        const selected = new Set(req.body.userIds);
        ids = ids.filter(id => selected.has(id));
      }
      // Bound provider work; callers can repeat after a batch has been approved.
      const offset = action === "preview" ? (req.body?.offset ?? 0) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({ error: "Invalid preview offset." });
      const truncated = ids.length > offset + 500;
      const nextOffset = truncated ? offset + 500 : null;
      ids = ids.slice(offset, offset + 500);
      const candidates = [];
      let approved = 0;
      let failed = 0;
      for (let offset = 0; offset < ids.length; offset += 8) {
        await Promise.all(ids.slice(offset, offset + 8).map(async id => {
          let info;
          try { info = await client.users.info({ user: id }); }
          catch { failed++; return; }
          const email = slackIdentityEmail(info?.user, id);
          if (!matchingApprovalDomain(email) || !eligibleForAutoApproval(await getUser(id))) return;
          if (action === "apply") {
            if (await autoApproveUser(id, email, "slack")) approved++;
          } else candidates.push({ id, name: users[id].name || id, email });
        }));
      }
      res.json({ candidates, approved, failed, truncated, nextOffset });
    } catch (error) { next(error); }
  });
  return router;
}
