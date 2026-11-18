// Cookie-authenticated Activity endpoints. The Activity context owns the person/workspace;
// callers never select another user's identity or an OAuth callback.
import { activityConnectionInventory, activityConnectionApps, createActivityConnection, ActivityConnectionsError } from "../gateway/activity-connections.js";

export function registerActivityConnectionRoutes(router, { context, csrfOk, services = {} }) {
  const inventory = services.inventory || activityConnectionInventory;
  const apps = services.apps || activityConnectionApps;
  const create = services.create || createActivityConnection;
  const errorReply = (res, error) => {
    const status = [401, 403].includes(error.status) ? error.status : error instanceof ActivityConnectionsError ? error.status : 503;
    return res.status(status).json({ error: error instanceof ActivityConnectionsError ? error.message : status === 401 || status === 403 ? "Your Activity session has ended." : "Connections are unavailable. Please try again." });
  };
  router.get("/:id/api/connections", async (req, res) => {
    try {
      const { session } = await context(req);
      const result = await inventory({ ownerId: session.ownerId, teamId: session.teamId });
      await context(req);
      return res.json(result);
    } catch (error) { return errorReply(res, error); }
  });
  router.get("/:id/api/connections/apps", async (req, res) => {
    try {
      const { session } = await context(req);
      const result = await apps({ query: req.query.query ?? "", cursor: req.query.cursor ?? "", ownerId: session.ownerId, teamId: session.teamId });
      await context(req);
      return res.json(result);
    } catch (error) { return errorReply(res, error); }
  });
  router.post("/:id/api/connections", async (req, res) => {
    try {
      const { session } = await context(req);
      if (!csrfOk(req, session) || !req.headers["x-cg-csrf"]) return res.status(403).json({ error: "Refresh your Activity session and try again." });
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["app", "alias"].includes(key))) {
        return res.status(400).json({ error: "Choose an application and optional account alias." });
      }
      const result = await create({ ownerId: session.ownerId, teamId: session.teamId, sessionId: req.params.id,
        app: body.app, alias: body.alias ?? "",
        callbackUrl: `${session.origin}/activity/${encodeURIComponent(req.params.id)}/settings/connections`,
        authorize: async () => { const current = await context(req); if (current.session !== session) throw Object.assign(new Error("Activity session changed"), { status: 401 }); },
      });
      await context(req);
      return res.json(result);
    } catch (error) { return errorReply(res, error); }
  });
}
