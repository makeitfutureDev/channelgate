// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROPRIETARY — MAKEITFUTURE S.R.L. All rights reserved.
// This file is part of src/ee/ and is NOT covered by the Sustainable Use License in LICENSE.md.
// It is source-visible so operators can audit the license check; use requires a valid license
// key issued by the Licensor. See src/ee/LICENSE-EE.md and LICENSE.md §3.2 / §4.5.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The two enforcement points, and the usage report.
//
//  (a) CONVERSATION ADMISSION. For a `conversations` limit of N, the first N distinct conversation
//      ids that receive an AI message in the current UTC month are that month's allowed set. The
//      set is persisted (license_usage.admitted, migration 12), so it survives a restart — without
//      that, every restart would re-open the allowance to whichever conversation spoke first next,
//      which is both wrong and gameable.
//
//  (b) MONTHLY CAP. Engine runs per conversation per UTC month, counted AT SPAWN, for every origin
//      except the deployment's own memory reviewer. At 80% the turn carries a one-time warning; at
//      the cap the turn is refused with the upgrade notice and no run starts.
//
// Nothing here throws into a run. A refusal is a RESULT — a short reply the caller delivers on the
// same path a normal answer takes — never silence and never an error: "silence that looks like
// death is the bug this exists to prevent" (AGENTS.md).
import { getDb } from "../db/index.js";
import { capabilitiesFor } from "../platforms/registry.js";
import { degradeMarkdown } from "../platforms/format/degrade.js";
import { platformOfConversation } from "../platforms/ids.js";
import { getEffectiveLimits, getLicenseKey, gatewayVersion, hasLicenseKey, installationId, isLicensed, offlineLicense, sha256Hex, utcMonth } from "./license.js";
import { PLATFORM_TIMEOUT_MS, USAGE_REPORT_INTERVAL_MS, platformBaseUrl, signupUrl } from "./tiers.js";

// The deployment's own memory-review runs are excluded from every count, by both of the ways a
// memory review identifies itself (docs/LICENSE-KEYS.md: "except the deployment's own
// memory-review runs"). Origin is the authority; CG_TOOLSET is the belt to its braces, because the
// reviewer is also the one path that spawns with a narrowed toolset.
export const EXEMPT_ORIGINS = Object.freeze(["memory_review"]);

export function isExemptRun({ origin = "", toolset = process.env.CG_TOOLSET } = {}) {
  return EXEMPT_ORIGINS.includes(String(origin)) || String(toolset || "") === "memory-review";
}

// The fraction of the cap at which a conversation is warned, once per UTC month.
export const WARN_AT = 0.8;

// ── Notice texts ──────────────────────────────────────────────────────────────────────────────
// Short, honest, and always carrying the way out. They are the ONLY thing a refused turn produces,
// so they have to answer "why did nothing happen?" on their own.
export function conversationLimitNotice({ limit, licensed, site = signupUrl() }) {
  if (!licensed) {
    return (
      `This ChannelGate install is limited to ${limit} conversation${limit === 1 ? "" : "s"} without a license key — ` +
      `get a free key at ${site} to unlock all channels.`
    );
  }
  return (
    `This ChannelGate license covers ${limit} conversation${limit === 1 ? "" : "s"} per month and this month's ` +
    `allowance is already in use by other conversations — raise the limit at ${site}.`
  );
}

export function monthlyCapNotice({ cap, month, licensed, site = signupUrl() }) {
  return (
    `This conversation has used all ${cap} AI messages for ${month} (UTC) on this ChannelGate install. ` +
    `The counter resets at the start of the next UTC month` +
    (licensed
      ? ` — an Enterprise License removes the limit: ${site}.`
      : ` — a free key at ${site} unlocks every channel, and an Enterprise License removes the message limit.`)
  );
}

export function warningNotice({ used, cap, month }) {
  return (
    `⚠️ _Heads up: this conversation has used ${used} of its ${cap} AI messages for ${month} (UTC). ` +
    `At the limit ChannelGate replies with a notice instead of starting a run._`
  );
}

// Degrade a notice for the surface it will be posted on. The notices are deliberately plain, so
// this is mostly a no-op today — it is here so that a future notice with a list or a table cannot
// ship a Slack-shaped string to Google Chat (AGENTS.md: degrade on the way OUT, never teach the
// model a per-surface dialect).
export function degradeNotice(text, conversationId) {
  return degradeMarkdown(text, capabilitiesFor(platformOfConversation(conversationId)));
}

// ── The ledger ────────────────────────────────────────────────────────────────────────────────
function row(month, conversationId) {
  return getDb()
    .prepare("SELECT * FROM license_usage WHERE month = ? AND conversation_id = ?")
    .get(month, conversationId) || null;
}

function admittedCount(month) {
  return Number(getDb().prepare("SELECT COUNT(*) AS n FROM license_usage WHERE month = ? AND admitted = 1").get(month)?.n || 0);
}

function ensureRow(month, conversationId, ts) {
  getDb()
    .prepare("INSERT OR IGNORE INTO license_usage(month, conversation_id, first_ts, last_ts) VALUES(?, ?, ?, ?)")
    .run(month, conversationId, ts, ts);
}

// Read-only view for the admin card and the MCP tool: this month's conversations, busiest first.
export function conversationUsage({ month = utcMonth(), limit = 20 } = {}) {
  const rows = getDb()
    .prepare("SELECT conversation_id, runs, admitted, warned, first_ts, last_ts FROM license_usage WHERE month = ? ORDER BY runs DESC, conversation_id ASC LIMIT ?")
    .all(month, Math.max(1, Math.min(500, Number(limit) || 20)));
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    runs: Number(r.runs) || 0,
    admitted: Boolean(r.admitted),
    warned: Boolean(r.warned),
    firstTs: r.first_ts || "",
    lastTs: r.last_ts || "",
  }));
}

export function usageTotals({ month = utcMonth() } = {}) {
  const r = getDb()
    .prepare("SELECT COUNT(*) AS conversations, COALESCE(SUM(runs),0) AS runs, COALESCE(SUM(admitted),0) AS admitted FROM license_usage WHERE month = ?")
    .get(month);
  return { month, conversations: Number(r?.conversations || 0), runs: Number(r?.runs || 0), admitted: Number(r?.admitted || 0) };
}

// Test seam / operator escape hatch: forget a month's ledger.
export function resetLicenseUsage({ month = "" } = {}) {
  if (month) getDb().prepare("DELETE FROM license_usage WHERE month = ?").run(month);
  else getDb().exec("DELETE FROM license_usage");
}

// ── (a) + (b): the admission gate ─────────────────────────────────────────────────────────────
// Called from the run orchestrator's admission path, before ANY side effect of the turn (folder
// provisioning, session mint, spawn). Returns:
//
//   { allowed: true,  warning: "" | "<one-time 80% warning>", … }
//   { allowed: false, reason: "conversation_limit" | "monthly_cap", notice: "<what to reply>", … }
//
// The whole read-modify-write runs inside one IMMEDIATE transaction: the daemon and the spawned
// MCP server share this database, and two turns admitted concurrently from the same conversation
// must not both read `runs = 499`.
export function licenseAdmission({ conversationId, origin = "", now = Date.now(), toolset = process.env.CG_TOOLSET } = {}) {
  const id = String(conversationId || "");
  const month = utcMonth(now);
  const limits = getEffectiveLimits(now);
  const licensed = isLicensed(now);
  const base = { allowed: true, warning: "", reason: "", notice: "", month, limits, runs: 0 };

  // The memory reviewer is the deployment talking to itself about a conversation that already
  // happened. It is excluded from the counts, so it is also excluded from the gate.
  if (!id || isExemptRun({ origin, toolset })) return { ...base, exempt: true };

  const ts = new Date(now).toISOString();
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureRow(month, id, ts);
    let r = row(month, id);

    // (a) Conversation admission.
    if (limits.conversations !== null && !r.admitted) {
      const used = admittedCount(month);
      if (used >= limits.conversations) {
        db.exec("COMMIT");
        return {
          ...base,
          allowed: false,
          reason: "conversation_limit",
          runs: Number(r.runs) || 0,
          notice: degradeNotice(conversationLimitNotice({ limit: limits.conversations, licensed }), id),
        };
      }
      db.prepare("UPDATE license_usage SET admitted = 1, admitted_seq = ? WHERE month = ? AND conversation_id = ?").run(used + 1, month, id);
      r = row(month, id);
    } else if (limits.conversations === null && !r.admitted) {
      // Unlimited: every conversation is in the set, so the flag stays truthful for the UI and for
      // a later downgrade (the month's existing conversations keep their admission).
      db.prepare("UPDATE license_usage SET admitted = 1 WHERE month = ? AND conversation_id = ?").run(month, id);
      r = row(month, id);
    }

    // (b) Monthly cap.
    const cap = limits.messagesPerConversationPerMonth;
    const used = Number(r.runs) || 0;
    if (cap !== null && used >= cap) {
      db.exec("COMMIT");
      return {
        ...base,
        allowed: false,
        reason: "monthly_cap",
        runs: used,
        notice: degradeNotice(monthlyCapNotice({ cap, month, licensed }), id),
      };
    }

    const runs = used + 1;
    db.prepare("UPDATE license_usage SET runs = ?, last_ts = ? WHERE month = ? AND conversation_id = ?").run(runs, ts, month, id);

    let warning = "";
    if (cap !== null && !r.warned && runs >= Math.ceil(cap * WARN_AT)) {
      db.prepare("UPDATE license_usage SET warned = 1 WHERE month = ? AND conversation_id = ?").run(month, id);
      warning = degradeNotice(warningNotice({ used: runs, cap, month }), id);
    }
    db.exec("COMMIT");
    return { ...base, runs, warning };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already gone */ }
    // A ledger failure must never take a turn down with it. Admit and say so in the log: an
    // operator losing a turn to a SQLite hiccup is a worse outcome than one uncounted run.
    console.warn(`[license] admission ledger failed (allowing the run): ${e?.message || e}`);
    return { ...base, ledgerError: String(e?.message || e) };
  }
}

// ── Usage report ──────────────────────────────────────────────────────────────────────────────
// EXACTLY what leaves the install (docs/PRIVACY-AND-DATA-FLOW.md): the installation id, the SHA-256
// of the key, the version, the UTC month, and per-conversation SHA-256 hashes with counts. No
// message content, no user ids, no channel names, no tokens, no file names. Built as a pure
// function so a test can assert the shape without a network.
export function buildUsageReport({ month = utcMonth(), limit = 1000 } = {}) {
  const key = getLicenseKey();
  const rows = getDb()
    .prepare("SELECT conversation_id, runs FROM license_usage WHERE month = ? AND runs > 0 ORDER BY conversation_id ASC LIMIT ?")
    .all(month, Math.max(1, Number(limit) || 1000));
  return {
    installationId: installationId(),
    keyHash: key ? sha256Hex(key) : "",
    version: gatewayVersion(),
    month,
    conversations: rows.map((r) => ({ hash: sha256Hex(r.conversation_id), count: Number(r.runs) || 0 })),
  };
}

// Fire-and-forget: daily and at shutdown. Never blocks a turn, never throws, and a platform that
// is down simply means this month's counts are reported on the next attempt.
export async function reportUsage({ fetchImpl = globalThis.fetch, month = utcMonth(), timeoutMs = PLATFORM_TIMEOUT_MS } = {}) {
  if (!hasLicenseKey()) return { sent: false, reason: "no_key" };
  // An air-gapped install runs on a signed offline payload precisely because it cannot reach the
  // platform. Reporting into a black hole every day would be noise, not telemetry.
  if (offlineLicense()) return { sent: false, reason: "offline" };
  let payload;
  try {
    payload = buildUsageReport({ month });
  } catch (e) {
    return { sent: false, reason: String(e?.message || e) };
  }
  if (!payload.conversations.length) return { sent: false, reason: "nothing to report" };
  try {
    const res = await fetchImpl(`${platformBaseUrl()}/v1/usage/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { sent: res.status === 204, status: res.status, payload };
  } catch (e) {
    return { sent: false, reason: String(e?.message || e), payload };
  }
}

let reportTimer = null;

export function startUsageReporting({ fetchImpl = globalThis.fetch, intervalMs = USAGE_REPORT_INTERVAL_MS } = {}) {
  stopUsageReporting();
  const tick = () => {
    reportUsage({ fetchImpl }).catch(() => { /* fire-and-forget by contract */ });
  };
  reportTimer = setInterval(tick, intervalMs);
  reportTimer.unref?.();
  return () => stopUsageReporting();
}

export function stopUsageReporting() {
  if (reportTimer) clearInterval(reportTimer);
  reportTimer = null;
}
