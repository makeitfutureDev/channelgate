// Admin view of the channel-level run API tokens (src/gateway/api-tokens.js): every token across
// conversations, name + channel + creator + last four + dates, and a revoke. Never a value — the
// value exists only in the tool result that minted it. Admin session only (mounted under the
// admin router; the run-API key never reaches these routes).
import express from "express";
import { listApiTokens, revokeApiToken, ApiTokenError } from "../../gateway/api-tokens.js";
import { listChannels } from "../../config/store.js";
import { logEvent } from "../../util/logger.js";

export function createApiTokensRouter() {
  const router = express.Router();

  router.get("/api-tokens", async (_req, res) => {
    const names = new Map((await listChannels()).map((c) => [c.channelId, c.name || c.slug]));
    res.json({
      ok: true,
      tokens: listApiTokens().map((t) => ({ ...t, channelName: names.get(t.channelId) || t.slug })),
    });
  });

  router.post("/api-tokens/:id/revoke", async (req, res) => {
    try {
      const token = revokeApiToken(req.params.id);
      await logEvent("api_token_revoked", { channel: token.channelId, slug: token.slug, id: token.id, name: token.name, owner: token.createdBy, author: "admin-ui" });
      res.json({ ok: true, token });
    } catch (e) {
      res.status(e instanceof ApiTokenError ? e.status : 500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
