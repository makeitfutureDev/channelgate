import { Router } from "express";
import { readSubscriptionUsage } from "../../gateway/subscription-usage.js";

// Mounted behind the existing admin identity gate, never exposed through public health/MCP.
export function createSubscriptionsRouter({ readUsage = readSubscriptionUsage } = {}) {
  const router = Router();
  router.get("/subscriptions", async (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await readUsage()); } catch (error) { next(error); }
  });
  return router;
}
