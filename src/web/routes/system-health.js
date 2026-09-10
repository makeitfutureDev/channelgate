import { Router } from "express";
import { getSystemHealth } from "../../gateway/system-health.js";

// Mounted only behind the existing admin authentication stack; never on public /api/health.
export function createSystemHealthRouter({ getService = getSystemHealth } = {}) {
  const router = Router();
  router.use("/system-health", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const handler = (action) => async (req, res) => {
    try { res.json(await action(getService(), req)); }
    catch { res.status(503).json({ error: "System health data unavailable" }); }
  };
  router.get("/system-health/current", handler((service) => service.current()));
  router.get("/system-health/history", (req, res, next) => {
    const range = req.query.range ?? "live";
    if (typeof range !== "string" || !["live", "1h", "24h", "7d", "30d"].includes(range)) return res.status(400).json({ error: "Invalid system health range" });
    return handler((service) => service.history(range))(req, res, next);
  });
  router.get("/system-health/storage", handler((service) => service.storage()));
  router.get("/system-health/hardware", handler((service) => service.hardware()));
  router.post("/system-health/hardware/refresh", handler((service) => service.refreshHardware()));
  return router;
}
