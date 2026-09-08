// Microsoft Graph basic notifications. Credentials and subscription state stay daemon-side.
import { randomBytes, timingSafeEqual } from "node:crypto";

const GRAPH = "https://graph.microsoft.com";
const LIFETIME = 55 * 60_000;
const RENEW_AFTER = 20 * 60_000;
const SAFE_ID = /^[A-Za-z0-9:@._-]+$/;
const safeId = value => typeof value === "string" && value !== "." && value !== ".." && value.length <= 1024 && SAFE_ID.test(value);
function segments(resource) {
  if (typeof resource !== "string" || resource.length > 8192) return null;
  try {
    const path = resource.replace(/^\//, "").replace(/\('([^']+)'\)/g, "/$1");
    const parts = path.split("/").map(decodeURIComponent);
    return parts.every(safeId) ? parts : null;
  } catch { return null; }
}
function baseResource(resource) {
  const parts = segments(resource);
  if (!parts) throw new Error("Invalid Teams Graph subscription resource");
  const chat = parts.length === 3 && parts[0] === "chats" && parts[2] === "messages";
  const channel = parts.length === 5 && parts[0] === "teams" && parts[2] === "channels" && parts[4] === "messages";
  if (!chat && !channel) throw new Error("Invalid Teams Graph subscription resource");
  return { parts, apiVersion: chat ? "beta" : "v1.0", resource: `/${parts.map(encodeURIComponent).join("/")}` };
}
function messagePath(notification, row) {
  const base = baseResource(row.resource).parts;
  const parts = segments(notification.resource);
  if (!parts || base.some((part, i) => parts[i] !== part)) return null;
  const suffix = parts.slice(base.length);
  const root = suffix.length === 1;
  const reply = base[0] === "teams" && suffix.length === 3 && suffix[1] === "replies";
  if (!root && !reply) return null;
  if (notification.resourceData?.id !== suffix.at(-1)) return null;
  return `/${parts.map(encodeURIComponent).join("/")}`;
}
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length > 128 || b.length > 128) return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function createTeamsGraphEvents({ auth, notificationUrl, tenantId, store, onMessage, enqueueNotifications = null, fetchImpl = fetch, now = Date.now, log = () => {}, intervalMs = 60_000 } = {}) {
  const endpoint = new URL(notificationUrl);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) throw new Error("Teams Graph notifications need a public HTTPS URL");
  if (!tenantId || !auth?.token || !store?.list || !store?.put || !onMessage) throw new Error("Teams Graph event dependencies are incomplete");
  let timer = null;
  let chain = Promise.resolve();
  const serialized = action => {
    const next = chain.then(action);
    chain = next.catch(() => {});
    return next;
  };
  async function request(version, path, method = "GET", body) {
    const res = await fetchImpl(`${GRAPH}/${version}${path}`, {
      method,
      headers: { authorization: `Bearer ${await auth.token()}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
    if (!res.ok) {
      const error = new Error(`Teams Graph request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return res.status === 204 ? null : res.json();
  }
  async function maintain(row) {
    const { resource, apiVersion } = baseResource(row.resource);
    const current = now();
    const sameEndpoint = row.notificationUrl === endpoint.href;
    if (sameEndpoint && row.subscriptionId && Date.parse(row.expiresAt) > current && Number(row.renewedAt || 0) + RENEW_AFTER > current) return row;
    const expiresAt = new Date(current + LIFETIME).toISOString();
    let result;
    if (sameEndpoint && row.subscriptionId && Date.parse(row.expiresAt) > current) {
      try { result = await request(apiVersion, `/subscriptions/${encodeURIComponent(row.subscriptionId)}`, "PATCH", { expirationDateTime: expiresAt }); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    if (!result) {
      const retiredId = !sameEndpoint && row.subscriptionId || row.retiredSubscriptionId;
      if (retiredId) {
        row = { ...row, retiredSubscriptionId: retiredId };
        try {
          await request(apiVersion, `/subscriptions/${encodeURIComponent(retiredId)}`, "DELETE");
          delete row.retiredSubscriptionId;
        } catch (error) {
          if (error.status === 404) delete row.retiredSubscriptionId;
          else log("Teams Graph prior subscription cleanup failed; retrying", { status: error.status || null });
        }
      }
      const clientState = randomBytes(32).toString("hex");
      // Persist the secret before creation; Graph validates the endpoint during this request.
      row = { ...row, resource, apiVersion, clientState, notificationUrl: endpoint.href, subscriptionId: null, startedAt: row.startedAt || new Date(current).toISOString() };
      await store.put(row);
      result = await request(apiVersion, "/subscriptions", "POST", {
        changeType: "created,updated,deleted", notificationUrl: endpoint.href,
        resource, includeResourceData: false, expirationDateTime: expiresAt, clientState,
      });
    }
    if (!safeId(result?.id)) throw new Error("Teams Graph subscription response has no valid id");
    row = { ...row, resource, apiVersion, subscriptionId: result.id, expiresAt: result.expirationDateTime || expiresAt, renewedAt: current };
    await store.put(row);
    return row;
  }
  async function ensure(contextRow) {
    return serialized(async () => {
      const prior = (await store.list()).find(row => row.conversationId === contextRow.conversationId);
      const base = baseResource(contextRow.resource);
      // A conversation never silently switches subscription scope.
      if (prior && baseResource(prior.resource).resource !== base.resource) throw new Error("Teams Graph conversation scope changed");
      const row = { ...prior, ...contextRow, ...base };
      delete row.parts;
      await store.put(row);
      try { return await maintain(row); }
      catch (error) { log("Teams Graph subscription unavailable; retrying automatically", { status: error.status || null }); return row; }
    });
  }
  async function remove(conversationId) {
    return serialized(async () => {
      const row = (await store.list()).find(item => item.conversationId === conversationId);
      await store.remove(conversationId);
      if (!row?.subscriptionId) return;
      try { await request(row.apiVersion || baseResource(row.resource).apiVersion, `/subscriptions/${encodeURIComponent(row.subscriptionId)}`, "DELETE"); }
      catch (error) { log("Teams Graph subscription revoked locally; remote expiry remains bounded", { status: error.status || null }); }
    });
  }
  async function renew() {
    return serialized(async () => {
      for (const row of await store.list()) {
        try { await maintain(row); }
        catch (error) { log("Teams Graph subscription renewal failed; retrying automatically", { status: error.status || null }); }
      }
    });
  }
  async function processNotifications(accepted) {
    for (const { event } of accepted) {
      const row = (await store.list()).find(item => item.subscriptionId && item.subscriptionId === event?.subscriptionId);
      const path = row && messagePath(event, row);
      // Uninstall or rotation may revoke an envelope after durable acceptance, before its GET.
      if (!row || !path || event.tenantId !== tenantId || !sameSecret(event.clientState, row.clientState)
        || !["created", "updated"].includes(event.changeType)) continue;
      let message;
      try { message = await request(row.apiVersion || baseResource(row.resource).apiVersion, path); }
      catch (error) { if (error.status === 404) continue; throw error; }
      if (message?.id !== event.resourceData.id) throw new Error("Teams Graph response message identity mismatch");
      await onMessage(message, row);
    }
  }
  async function handle(req, res) {
    const validation = req.query?.validationToken;
    if (typeof validation === "string" && validation.length > 0 && validation.length <= 4096) {
      res.status(200).type("text/plain").send(validation);
      return;
    }
    const batch = req.body?.value;
    if (!Array.isArray(batch) || !batch.length || batch.length > 100) { res.status(400).end(); return; }
    try {
      const rows = await store.list();
      const accepted = [];
      for (const event of batch) {
        const row = rows.find(item => item.subscriptionId && item.subscriptionId === event?.subscriptionId);
        const path = row && messagePath(event, row);
        if (!row || !path || event.tenantId !== tenantId || !sameSecret(event.clientState, row.clientState) || !["created", "updated", "deleted"].includes(event.changeType)) {
          res.status(403).end(); return;
        }
        accepted.push({ event, row, path });
      }
      if (enqueueNotifications) {
        await enqueueNotifications(accepted);
        res.status(202).end();
        return;
      }
      await processNotifications(accepted);
      res.status(200).end();
    } catch (error) {
      log("Teams Graph notification failed; delivery will be retried", { status: error.status || null });
      res.status(503).end();
    }
  }
  return {
    ensure, handle, renew, remove, processNotifications,
    start() { if (!timer) { timer = setInterval(() => { void renew().catch(() => {}); }, Math.max(10, intervalMs)); timer.unref?.(); void renew().catch(() => {}); } },
    async stop() { if (timer) clearInterval(timer); timer = null; await chain; },
  };
}
