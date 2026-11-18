// Durable owner-scoped device registration and single-use incoming-call invitations.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getDb } from "../../db/index.js";
import { getIosCallConfig, getVoiceCallConfig } from "../../config/settings.js";
import { getChannelMeta, getChannelEntry, getUser } from "../../config/store.js";
import { isAuthorized } from "../modes.js";
import { isSlackThreadParticipant } from "../slack-threads.js";
import { liveConnector } from "../../platforms/live.js";
import { platformOfConversation } from "../../platforms/ids.js";
import { postNotice } from "../../platforms/notify.js";
import { pushConfigReady, sendVoipPush, type PushConfig, type PushDevice, type PushResult } from "./apns.ts";

type DeviceRow = PushDevice & { id: string; owner_id: string; bundle_id: string; name: string; last_seen_ms: number };
type Invitation = { id: string; owner_id: string; channel_id: string; thread_ts: string; token_hash: string; title: string; status: string; expires_ms: number; ring_ms: number; created_ms: number; call_id: string };
export interface InviteTarget { ownerId: string; channelId: string; threadTs: string }
export interface DeviceInput { platform?: unknown; kind?: unknown; token?: unknown; bundleId?: unknown; environment?: unknown; name?: unknown }
interface Dependencies {
  config?: () => PushConfig;
  now?: () => number;
  voiceEnabled?: () => boolean;
  authorize?: (target: InviteTarget) => Promise<boolean>;
  send?: (config: PushConfig, device: PushDevice, payload: Record<string, unknown>, id: string) => Promise<PushResult>;
  notify?: (invitation: Invitation, outcome: string) => Promise<void>;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const error = (message: string, status = 400) => Object.assign(new Error(message), { status });
async function currentAccess(target: InviteTarget): Promise<boolean> {
  const user = await getUser(target.ownerId);
  const entry = await getChannelEntry(target.channelId);
  if (!user || (!user.approved && !user.isAdmin) || !entry) return false;
  const meta = await getChannelMeta(entry.slug);
  return Boolean(meta && isAuthorized(meta, target.ownerId, entry.isDM, { isAdminUser: user.isAdmin === true, isApprovedUser: user.approved === true })
    && isSlackThreadParticipant(target.channelId, target.threadTs, target.ownerId));
}
export function createIncomingCalls(deps: Dependencies = {}) {
  const config = deps.config || getIosCallConfig;
  const now = deps.now || Date.now;
  const authorize = deps.authorize || currentAccess;
  const send = deps.send || sendVoipPush;
  const voiceEnabled = deps.voiceEnabled || (() => { const c = getVoiceCallConfig(); return c.enabled && Boolean(c.apiKey); });
  const notify = deps.notify || (async (invitation, outcome) => {
    const connector = liveConnector(platformOfConversation(invitation.channel_id));
    if (!connector) throw new Error("Conversation connector unavailable.");
    const notice = { conversationId: invitation.channel_id, threadKey: invitation.thread_ts, text: `📞 Incoming agent call: ${outcome}.` };
    await postNotice(connector, notice);
  });
  const targetOf = (row: Invitation): InviteTarget => ({ ownerId: row.owner_id, channelId: row.channel_id, threadTs: row.thread_ts });
  function expire() {
    const db = getDb();
    db.prepare("UPDATE incoming_calls SET notified=0 WHERE notified=2 AND notice_claim_ms<?").run(now() - 60_000);
    db.prepare("UPDATE incoming_calls SET status='missed' WHERE status='ringing' AND expires_ms<=?").run(now());
    db.prepare("UPDATE incoming_calls SET status='failed' WHERE status='accepting' AND expires_ms<?").run(now() - 60_000);
    db.prepare("DELETE FROM incoming_calls WHERE created_ms<? AND status NOT IN ('ringing','accepting')").run(now() - 7 * 86400_000);
  }
  async function flushNotices() {
    expire();
    const due = getDb().prepare("SELECT * FROM incoming_calls WHERE status='scheduled' AND ring_ms<=? ORDER BY ring_ms LIMIT 20").all(now()) as unknown as Invitation[];
    for (const row of due) {
      // Claim before asynchronous checks, so two processes cannot deliver the same schedule.
      const token = randomBytes(32).toString("base64url");
      if (!getDb().prepare("UPDATE incoming_calls SET status='ringing',token_hash=?,expires_ms=? WHERE id=? AND status='scheduled'").run(digest(token), now() + 45_000, row.id).changes) continue;
      try {
        if (now() - row.ring_ms > 60_000 || !(await authorize(targetOf(row)))) throw error("Scheduled call expired or access ended.");
        await deliver(row.id, targetOf(row), row.title, token);
      } catch { getDb().prepare("UPDATE incoming_calls SET status='failed' WHERE id=? AND status='ringing'").run(row.id); }
    }
    const db = getDb();
    const rows = db.prepare("SELECT * FROM incoming_calls WHERE notified=0 AND status IN ('declined','missed','failed') LIMIT 50").all() as unknown as Invitation[];
    for (const row of rows) {
      if (!db.prepare("UPDATE incoming_calls SET notified=2,notice_claim_ms=? WHERE id=? AND notified=0").run(now(), row.id).changes) continue;
      try { await notify(row, row.status); db.prepare("UPDATE incoming_calls SET notified=1 WHERE id=?").run(row.id); }
      catch { db.prepare("UPDATE incoming_calls SET notified=0 WHERE id=?").run(row.id); }
    }
  }
  function listDevices(ownerId: string) {
    // Tokens and token hashes never appear in a listing response.
    return getDb().prepare("SELECT id, name, bundle_id AS bundleId, environment, last_seen_ms AS lastSeen FROM user_devices WHERE owner_id=? ORDER BY last_seen_ms DESC").all(ownerId);
  }
  function registerDevice(ownerId: string, input: DeviceInput) {
    const c = config();
    const token = typeof input.token === "string" ? input.token.toLowerCase() : "";
    if (!ownerId || input.platform !== "ios" || input.kind !== "voip" || input.bundleId !== c.bundleId
        || !/^[a-f0-9]{32,512}$/.test(token) || token.length % 2 || !["sandbox", "production"].includes(String(input.environment))) throw error("Invalid iPhone registration.");
    const db = getDb();
    const old = db.prepare("SELECT id, owner_id FROM user_devices WHERE token=? AND bundle_id=? AND environment=?").get(token, c.bundleId, String(input.environment)) as { id: string; owner_id: string } | undefined;
    const id = old?.id || randomUUID();
    if ((!old || old.owner_id !== ownerId) && listDevices(ownerId).length >= 10) throw error("Remove an old device before registering another.", 429);
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "iPhone";
    db.prepare(`INSERT INTO user_devices(id,owner_id,token,bundle_id,environment,name,created_ms,last_seen_ms) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, name=excluded.name, last_seen_ms=excluded.last_seen_ms`)
      .run(id, ownerId, token, c.bundleId, String(input.environment), name, now(), now());
    return { ok: true, id };
  }
  function removeDevice(ownerId: string, id: string) {
    getDb().prepare("DELETE FROM user_devices WHERE owner_id=? AND id=?").run(ownerId, id);
    return { ok: true };
  }
  function cancel(ownerId: string, id: string) {
    getDb().prepare("UPDATE incoming_calls SET status='cancelled',notified=1 WHERE owner_id=? AND id=? AND status='scheduled'").run(ownerId, id);
    return { ok: true };
  }
  async function request(target: InviteTarget, title: string, inMinutes = 0) {
    const c = config();
    if (!pushConfigReady(c) || !voiceEnabled()) throw error("Incoming calls are not configured. Ask an administrator to configure iPhone calls.", 503);
    if (!/^[A-Z0-9_]{1,32}$/.test(target.channelId) || !/^\d{1,13}\.\d{1,6}$/.test(target.threadTs)
        || !(await authorize(target))) throw error("Current conversation access is required.", 403);
    if (typeof title !== "string" || !title.trim() || title.length > 160) throw error("Give a call reason of 1–160 characters.");
    if (!Number.isInteger(inMinutes) || inMinutes < 0 || inMinutes > 10080) throw error("Delay must be 0–10080 whole minutes.");
    expire();
    const db = getDb();
    const devices = db.prepare("SELECT * FROM user_devices WHERE owner_id=? AND bundle_id=?").all(target.ownerId, c.bundleId) as unknown as DeviceRow[];
    if (!devices.length) throw error("No iPhone registered. Sign in to the iPhone app and enable incoming calls.", 409);
    // Serialize admission with an immediate transaction: concurrent runs cannot ring twice.
    const id = randomUUID(), token = randomBytes(32).toString("base64url");
    db.exec("BEGIN IMMEDIATE");
    try {
      const recent = db.prepare("SELECT COUNT(*) AS n FROM incoming_calls WHERE owner_id=? AND created_ms>?").get(target.ownerId, now() - 3600_000) as { n: number };
      const active = db.prepare("SELECT id FROM incoming_calls WHERE owner_id=? AND (status IN ('scheduled','ringing','accepting') OR created_ms>?)").get(target.ownerId, now() - 60_000);
      if (active || recent.n >= 10) throw error("An incoming call is pending or the call limit was reached. Try later.", 429);
      db.prepare("INSERT INTO incoming_calls(id,owner_id,channel_id,thread_ts,token_hash,title,status,created_ms,expires_ms,ring_ms) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(id, target.ownerId, target.channelId, target.threadTs, inMinutes ? "" : digest(token), title.trim(), inMinutes ? "scheduled" : "ringing", now(), inMinutes ? 0 : now() + 45_000, now() + inMinutes * 60_000);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    if (inMinutes) return { ok: true, id, delivered: 0, scheduledAt: now() + inMinutes * 60_000, expiresAt: 0 };
    const delivered = await deliver(id, target, title.trim(), token);
    return { ok: true, id, delivered, scheduledAt: 0, expiresAt: now() + 45_000 };
  }
  async function deliver(id: string, target: InviteTarget, title: string, token: string) {
    const db = getDb(), c = config();
    if (!pushConfigReady(c) || !voiceEnabled()) throw error("Incoming calls are disabled.", 503);
    const devices = db.prepare("SELECT * FROM user_devices WHERE owner_id=? AND bundle_id=?").all(target.ownerId, c.bundleId) as unknown as DeviceRow[];
    let delivered = 0;
    await Promise.all(devices.map(async device => {
      try {
        const result = await send(c, device, { aps: { "content-available": 1 }, uuid: id, channelId: target.channelId,
          threadTs: target.threadTs, title: title.trim(), agent: "ChannelGate", token }, id);
        if (result.status === 200) delivered++;
        else if (result.status === 410 || result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic") {
          // Delete only this registration, and only if ownership still matches.
          db.prepare("DELETE FROM user_devices WHERE id=? AND owner_id=?").run(device.id, target.ownerId);
        }
      } catch { /* Never expose APNs credentials, tokens or raw transport errors. */ }
    }));
    if (!delivered) {
      db.prepare("UPDATE incoming_calls SET status='failed' WHERE id=? AND status='ringing'").run(id);
      throw error("Apple did not accept the incoming call. Check APNs configuration and device registration.", 502);
    }
    return delivered;
  }
  async function claim(ownerId: string, token: string, status: "accepting" | "declined") {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw error("Call invitation is unavailable.", 404);
    expire();
    const db = getDb();
    const row = db.prepare("SELECT * FROM incoming_calls WHERE owner_id=? AND token_hash=? AND status='ringing' AND expires_ms>?").get(ownerId, digest(token), now()) as unknown as Invitation | undefined;
    if (!row || !(await authorize(targetOf(row)))) throw error("Call invitation is unavailable.", 404);
    if (!db.prepare("UPDATE incoming_calls SET status=? WHERE id=? AND status='ringing' AND expires_ms>?").run(status, row.id, now()).changes) throw error("Call invitation was already handled.", 409);
    return row;
  }
  async function accept<T extends { id: string }>(ownerId: string, token: string, start: (target: InviteTarget, reason: string) => Promise<T>): Promise<T> {
    if (!pushConfigReady(config()) || !voiceEnabled()) throw error("Call invitation is unavailable.", 404);
    const row = await claim(ownerId, token, "accepting");
    try {
      const call = await start(targetOf(row), row.title);
      getDb().prepare("UPDATE incoming_calls SET status='accepted',call_id=?,notified=1 WHERE id=?").run(call.id, row.id);
      return call;
    } catch (e) {
      getDb().prepare("UPDATE incoming_calls SET status='failed' WHERE id=?").run(row.id);
      throw e;
    }
  }
  async function decline(ownerId: string, token: string) { await claim(ownerId, token, "declined"); await flushNotices(); return { ok: true }; }
  let timer: ReturnType<typeof setInterval> | undefined;
  function start() {
    if (timer) return;
    timer = setInterval(() => { void flushNotices().catch(() => {}); }, 5000);
    timer.unref();
    void flushNotices().catch(() => {});
  }
  function stop() { if (timer) clearInterval(timer); timer = undefined; }
  return { registerDevice, listDevices, removeDevice, cancel, request, accept, decline, expire, flushNotices, start, stop };
}
let singleton: ReturnType<typeof createIncomingCalls> | undefined;
export function incomingCalls() { return singleton ||= createIncomingCalls(); }

export function getIncomingCallList(ownerId: string) {
  return getDb().prepare("SELECT id, title, status, created_ms AS createdAt, ring_ms AS scheduledAt FROM incoming_calls WHERE owner_id=? ORDER BY created_ms DESC LIMIT 30").all(ownerId);
}
