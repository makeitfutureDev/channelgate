// The Teams inbound endpoint.
//
// Teams is the one surface with no outbound-only receive path: Azure Bot Service POSTs activities to
// a registered HTTPS URL and there is no Socket Mode equivalent. The daemon already terminates
// public HTTPS for the admin UI and the run API, so the endpoint rides that server rather than
// adding a second listener. (An Azure Relay Hybrid Connection would remove the public URL
// requirement; it is a transport swap in FRONT of this handler — everything below stays.)
//
// Two rules the handler exists to enforce:
//   • authenticate BEFORE looking at the body — the endpoint is public
//   • persist verified activity before answering 200, then dispatch asynchronously — Bot Service
//     retries anything else, and an acknowledged request must survive a daemon restart
import { createHash } from "node:crypto";
import { isTeamsCardInteraction, teamsCardErrorResponse } from "./interactions.js";
import { verifyTeamsRequest, activityFingerprint, createJwksCache } from "./verify.js";
import { normalizeActivity } from "./activity.js";
import { validateServiceUrl } from "./api.js";
import { createDedupe } from "../googlechat/pubsub.js";

// Rebuild lazy attachment callbacks at dispatch, never serialize normalized messages/functions.
// Durable intake lets handler failures propagate so ambiguous work gets an interruption notice.
export function createTeamsActivityDispatcher({ botId = "", onMessage, onActivity = null, graphEventsEnabled = false, resolveFile = null, getActivationReactions = () => undefined } = {}) {
  return async function dispatchTeamsActivity({ activity, serviceUrl }) {
    if (onActivity) await onActivity(activity);
    // Graph owns revisions/reactions in non-personal conversations when enabled.
    if (graphEventsEnabled && String(activity.conversation?.conversationType).toLowerCase() !== "personal"
      && ["messageupdate", "messagereaction"].includes(String(activity.type).toLowerCase())) return;
    const message = normalizeActivity(activity, { botId, resolveFile, activationReactions: getActivationReactions() });
    if (message) await onMessage(message, { serviceUrl });
  };
}

export function createTeamsWebhook({ appId, botId = "", onMessage, jwks = null, log = console, dedupe = null, onActivity = null, graphEventsEnabled = false, onInvoke = null, resolveFile = null, getActivationReactions = () => undefined, acceptActivity = null } = {}) {
  if (!appId) throw new Error("Teams webhook requires the bot app id");
  if (typeof onMessage !== "function") throw new TypeError("Teams webhook requires an onMessage handler");
  const keys = jwks || createJwksCache();
  const seen = dedupe || createDedupe(500);
  const invokes = new Map();
  const dispatch = createTeamsActivityDispatcher({ botId, onMessage, onActivity, graphEventsEnabled, resolveFile, getActivationReactions });

  return async function handleTeamsActivity(req, res) {
    const activity = req.body || {};
    // The serviceUrl is checked against the Bot Framework host allowlist here as well as in the API
    // client: a forged activity naming a hostile serviceUrl should be rejected at the door, not
    // discovered later when a reply fails.
    const serviceUrl = validateServiceUrl(activity.serviceUrl);
    const verdict = await verifyTeamsRequest({
      authorization: req.get?.("authorization") || req.headers?.authorization,
      appId,
      serviceUrl,
      jwks: keys,
    });
    if (!verdict.ok) {
      log.warn?.(`[msteams] rejected inbound activity: ${verdict.reason}`);
      // Deliberately contentless: naming the failed check tells a prober how to get closer.
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (activity.serviceUrl && !serviceUrl) {
      log.warn?.("[msteams] rejected inbound activity: serviceUrl is not a Bot Framework host");
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    if (isTeamsCardInteraction(activity)) {
      const reject = (status, code, message) => {
        const result = teamsCardErrorResponse(activity, status, code, message);
        res.status(result.status).json(result.body);
      };
      if (!onInvoke) { reject(501, "NotImplemented", "Teams card actions are not configured"); return; }
      if (!activity.id || !activity.from?.id || !activity.conversation?.id) { reject(400, "BadRequest", "Incomplete card interaction"); return; }
      // Retried invokes must return the same result, including retries arriving during dispatch.
      // Business handlers additionally enforce persisted single-use ownership for mutations.
      const key = createHash("sha256").update(JSON.stringify([activity.id, activity.from.id, activity.conversation.id])).digest("hex");
      for (const [id, entry] of invokes) if (entry.finished && entry.at < Date.now() - 600_000) invokes.delete(id);
      if (!invokes.has(key)) {
        if (invokes.size >= 500) { reject(429, "TooManyRequests", "Card action capacity reached; retry later"); return; }
        const entry = { at: Date.now(), finished: false };
        entry.result = Promise.resolve().then(() => onInvoke(activity)).then(result => {
          if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599) throw new Error("Invalid Teams invoke response");
          return result;
        }).catch(() => {
          log.error?.("[msteams] card action failed");
          return teamsCardErrorResponse(activity, 500, "InternalServerError", "Card action failed. Reopen the controls before trying again.");
        }).finally(() => { entry.finished = true; });
        invokes.set(key, entry);
      }
      const result = await invokes.get(key).result;
      res.status(result.status).json(result.body ?? {});
      return;
    }

    if (acceptActivity) {
      if (!activity.id || !activity.conversation?.id) {
        res.status(400).json({ error: "incomplete activity" });
        return;
      }
      try {
        // Only verified raw activity crosses the persistence boundary. Acceptance is fast;
        // normalization and engine work happen in the durable inbox after the HTTP response.
        await acceptActivity({ activity, serviceUrl });
      } catch (error) {
        log.error?.(`[msteams] durable acceptance failed: ${error?.message || error}`);
        res.status(503).json({ error: "temporarily unavailable" });
        return;
      }
      res.status(200).json({});
      return;
    }

    res.status(200).json({});

    try {
      if (seen.isDuplicate(activityFingerprint(activity))) return;
      await dispatch({ activity, serviceUrl });
    } catch (err) {
      log.error?.(`[msteams] inbound handling failed: ${err?.message || err}`);
    }
  };
}
