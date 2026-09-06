// The public surface of link-based approvals: two routes, no admin session, no cookie.
//
//   GET  /approve/<token>   → a confirmation page. Reads. Decides nothing.
//   POST /approve/<token>   → the decision, exactly once, through the SAME appliers the Slack
//                             buttons and the admin API use.
//
// The GET/POST split is not ceremony. Slack unfurls links in messages, Teams' preview service
// fetches them, mail and corporate proxies pre-open everything inbound, and browsers prefetch. A
// GET that decided anything would mean the unfurler approving the request before a human ever saw
// it. So the page is the only thing a fetch can obtain, and the decision needs a deliberate form
// submission carrying the same token.
//
// Authority: the token is a bearer credential minted FOR one person (the requester) and delivered
// privately, so possession is the first factor — but never the only one. Every POST re-runs the
// approval's own authorization (`canResolveApproval`) against the requester the link was minted
// for, so a link cannot outlive the person's access, and a tier the requester could not satisfy by
// clicking (an admin-tier control-plane sign-off, "approve forever") is refused here too. Minting
// already withholds those links; this is the check that makes the refusal true rather than
// cosmetic.
import { randomBytes } from "node:crypto";
import { Router } from "express";

import { applyApprovalDecision, canResolveApproval, lookupApproval } from "../../slack/approvals.js";
import { applyBusyThreadChoice, busyThreadChoices, BUSY_THREAD_CHOICE_KIND, BUSY_THREAD_CHOICES } from "../../slack/busy-thread-choice.js";
import { processMessageEvent } from "../../slack/message-pipeline.js";
import { consumeApprovalLinkToken, inspectApprovalLinkToken, retireApprovalLinkTokens } from "../../gateway/approval-link-tokens.js";
import { verifyApprovalLinkToken } from "../approval-links.js";
import { createLoginLimiter } from "../security.js";
import { getUsers } from "../../config/store.js";
import { logEvent } from "../../util/logger.js";

// The principal a link decision is recorded as. `actorId` is what the waiting agent receives as
// `decided_by`, and it is deliberately the WORD "link" rather than the requester's user id: the
// decision came through a bearer URL, and an agent (or an auditor) reading `decided_by` should see
// the channel it arrived by, not a claim that someone clicked in the chat client. The requester's
// identity rides the actor LABEL (which is what the card shows) and the audit event.
export const APPROVAL_LINK_PRINCIPAL = "link";

// Failed token lookups are the one thing a stranger can drive here, so they get the same per-IP
// exponential backoff as a failed admin login. A CORRECT token never records a failure, so a
// person retrying their own link is never slowed down.
const DEFAULT_LIMITER = { freeAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000 };

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

// Cache-control + noindex on every response: these URLs are single-use credentials, and a cached
// or indexed one is a credential in a place nobody is watching. The CSP is the tightest one a page
// can have — no scripts at all, one nonce'd stylesheet, and `form-action 'self'` so nothing can
// re-target the Confirm button at another origin.
function pageHeaders(res, nonce) {
  res.set({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
}

const STYLE = `body{margin:0;background:#f7f6f3;color:#252421;font:15px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh}
.card{max-width:640px;margin:24px;padding:28px 30px;background:#fff;border:1px solid #ddd8cf;border-radius:16px;box-shadow:0 12px 40px #0001}
h1{margin:0 0 4px;font-size:21px}.sub{margin:0 0 18px;color:#75716a;font-size:13px}
dl{margin:0 0 18px;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px}
dt{color:#75716a}dd{margin:0;word-break:break-word}
pre{margin:0 0 18px;padding:12px 14px;background:#f3f1ec;border:1px solid #e3ded5;border-radius:10px;overflow:auto;max-height:320px;white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.act{margin:0 0 18px;padding:12px 14px;border-radius:10px;background:#fdf6ee;border:1px solid #f0dfc8;font-weight:600}
.act.deny{background:#fdf1f1;border-color:#f0cccc}
button{appearance:none;border:0;border-radius:10px;padding:11px 20px;font-size:15px;font-weight:650;cursor:pointer;background:#087a5b;color:#fff}
button.deny{background:#b33030}
.note{margin:14px 0 0;color:#75716a;font-size:12px}
.ok{color:#087a5b;font-weight:650}.bad{color:#b33030;font-weight:650}`;

function page(res, status, title, bodyHtml) {
  const nonce = randomBytes(16).toString("base64url");
  pageHeaders(res, nonce);
  return res.status(status).type("html").send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">` +
      `<title>${escapeHtml(title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><main class="card">${bodyHtml}</main></body></html>`,
  );
}

// Every dead end reads the same and says nothing about any other request: an unknown token, a
// token for someone else's approval and a token that was already spent must not be tellable apart
// by someone fishing. The only distinction kept is used/expired vs unknown, because that is the
// difference between "you already answered this" and "this was never a link".
function deadEnd(res, reason) {
  if (reason === "forbidden") {
    // The holder of this link IS the person it was minted for, so telling them their authority
    // changed leaks nothing they did not already know and is the only message they can act on.
    return page(res, 403, "Approval link", '<h1>Not yours to decide</h1><p class="sub">This link can no longer be honoured: deciding this request now needs authority you do not have in that conversation. Someone who does can still answer the card there.</p>');
  }
  const known = reason === "used" || reason === "expired" || reason === "resolved";
  const message =
    reason === "used"
      ? "This approval link was already used. Each link works exactly once."
      : reason === "expired"
        ? "This approval link has expired. Ask the agent again, or answer the card in the conversation."
        : reason === "resolved"
          ? "This request was already decided — in the conversation, from the admin UI, or by another link."
          : "This approval link is not valid. It may have expired, been used, or been copied incompletely.";
  return page(res, known ? 410 : 404, "Approval link", `<h1>Nothing to decide</h1><p class="sub">${escapeHtml(message)}</p>`);
}

const clip = (value, max = 1_600) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n… (+${text.length - max} more characters not shown)` : text;
};

const ACTION_LABEL = {
  approve: { once: "Approve once", thread: "Approve for this thread", forever: "Approve forever (this channel)" },
  deny: { "": "Deny" },
  steer: { "": "Steer the conversation with this message" },
  queue: { "": "Add this message to the queue" },
  cancel: { "": "Cancel this message" },
};

export function approvalLinkActionLabel(action, scope = "") {
  return ACTION_LABEL[action]?.[scope || ""] || ACTION_LABEL[action]?.[""] || ACTION_LABEL[action]?.once || action;
}

// ── One resolution of "what does this token point at, and may it still act?" ────
// Shared by GET and POST so the page can never describe a request the POST would refuse. Returns
// either a refusal reason or everything both halves need.
async function resolveToken(claims) {
  if (claims.kind === "thread_choice") {
    const record = busyThreadChoices.list().find((row) => row.id === claims.id);
    if (!record) return { ok: false, reason: "resolved" };
    if (!BUSY_THREAD_CHOICES.includes(claims.action)) return { ok: false, reason: "invalid" };
    return { ok: true, kind: "thread_choice", record, requesterId: record.authorId || record.event?.user || "" };
  }
  const { entry, durable, resolved } = lookupApproval(claims.id);
  if (!entry) return { ok: false, reason: resolved ? "resolved" : "invalid" };
  const requesterId = entry.authorId || "";
  const authority = await canResolveApproval(entry, requesterId);
  if (!authority.allowed) return { ok: false, reason: "forbidden" };
  // Approving is tiered; denying never is. "Forever" changes the channel's posture and stays an
  // admin's call, exactly as it is on the buttons.
  if (claims.action === "approve") {
    if (!authority.meetsTier) return { ok: false, reason: "forbidden" };
    if (claims.scope === "forever" && !authority.clickerIsAdmin) return { ok: false, reason: "forbidden" };
    if (durable && claims.scope && claims.scope !== "once") return { ok: false, reason: "invalid" };
  } else if (claims.action !== "deny") {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, kind: "approval", entry, durable, requesterId };
}

export function createApprovalLinkRouter({
  slack,
  processMessage = processMessageEvent,
  limiter = createLoginLimiter(DEFAULT_LIMITER),
  now = () => Date.now(),
} = {}) {
  const router = Router();
  // No body parser at all: the POST carries everything it needs in the URL, the form has no fields,
  // and a router that never reads a body cannot be fed one.
  const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || "unknown");

  // Verify signature + expiry and check the single-use ledger WITHOUT spending it. Both verbs
  // start here; only POST goes on to spend, and only after every refusal has been ruled out — a
  // link that could not be honoured must still be there when the reason is fixed. A bad token is
  // the only thing that counts against the limiter; a well-signed token that is merely spent is
  // the same person clicking twice, not an attack.
  const openToken = (req, res) => {
    const ip = clientIp(req);
    const wait = limiter.retryAfterMs(ip, now());
    if (wait > 0) {
      res.set("Retry-After", String(Math.ceil(wait / 1000)));
      page(res, 429, "Approval link", '<h1>Too many attempts</h1><p class="sub">Too many invalid approval links from this address. Wait a moment and try your link again.</p>');
      return null;
    }
    const verified = verifyApprovalLinkToken(req.params.token, { now: now() });
    if (!verified.ok) {
      limiter.recordFailure(ip, now());
      deadEnd(res, verified.reason === "expired" ? "expired" : "invalid");
      return null;
    }
    const ledger = inspectApprovalLinkToken(verified.claims.nonce, now());
    if (!ledger.ok) {
      deadEnd(res, ledger.reason === "unknown" ? "invalid" : ledger.reason);
      return null;
    }
    limiter.recordSuccess(ip);
    return verified.claims;
  };

  // Spend the nonce. This is the point of no return, and it is one atomic UPDATE: two simultaneous
  // Confirms carrying the same token both pass every check above, and exactly one of them gets
  // past here.
  const spendToken = (res, claims) => {
    const spent = consumeApprovalLinkToken(claims.nonce, now());
    if (!spent.ok) {
      deadEnd(res, spent.reason === "unknown" ? "invalid" : spent.reason);
      return false;
    }
    return true;
  };

  // ── GET: describe, never decide ──────────────────────────────────────────────
  router.get("/:token", async (req, res, next) => {
    try {
      const claims = openToken(req, res);
      if (!claims) return;
      const target = await resolveToken(claims);
      if (!target.ok) return deadEnd(res, target.reason);

      const users = await getUsers().catch(() => ({}));
      const requesterName = users[target.requesterId]?.name || target.requesterId || "unknown";
      const label = approvalLinkActionLabel(claims.action, claims.scope);
      const expiresIn = Math.max(1, Math.round((claims.expiresAt - now()) / 60000));
      const deny = claims.action === "deny" || claims.action === "cancel";

      const rows =
        target.kind === "thread_choice"
          ? [["Conversation", target.record.slug || target.record.channelId || ""], ["Requested by", requesterName]]
          : [
              ["Tool", target.entry.toolName || ""],
              ["Conversation", target.entry.slug || target.entry.channelId || ""],
              ["Requested by", requesterName],
            ];
      const preview =
        target.kind === "thread_choice"
          ? clip(target.record.event?.text || "", 600)
          : clip(target.entry.target || "");

      return page(
        res,
        200,
        "Confirm approval",
        `<h1>${escapeHtml(target.kind === "thread_choice" ? "A message is waiting on you" : "Approval requested")}</h1>` +
          `<p class="sub">Review this, then confirm. Opening this page changed nothing.</p>` +
          `<dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}` +
          `<dt>Link expires</dt><dd>in about ${expiresIn} minute${expiresIn === 1 ? "" : "s"}</dd></dl>` +
          (preview ? `<pre>${escapeHtml(preview)}</pre>` : "") +
          `<p class="act${deny ? " deny" : ""}">This link performs: ${escapeHtml(label)}</p>` +
          // A RELATIVE action (the token alone) posts back to this exact URL, so the page keeps
          // working when the gateway is reached through a reverse proxy that mounts it under a
          // path prefix. The token's charset is closed to [A-Za-z0-9._-] by verification above.
          `<form method="post" action="${escapeHtml(req.params.token)}">` +
          `<button class="${deny ? "deny" : ""}" type="submit">Confirm — ${escapeHtml(label)}</button></form>` +
          `<p class="note">This link works once and only for this request. Nothing happens until you press Confirm.</p>`,
      );
    } catch (e) {
      next(e);
    }
  });

  // ── POST: the decision, through the shared appliers ──────────────────────────
  router.post("/:token", async (req, res, next) => {
    try {
      const claims = openToken(req, res);
      if (!claims) return;
      const target = await resolveToken(claims);
      if (!target.ok) return deadEnd(res, target.reason);

      const users = await getUsers().catch(() => ({}));
      const requesterName = users[target.requesterId]?.name || target.requesterId || "someone";
      const client = slack?.getClient?.() || null;

      if (target.kind === "thread_choice") {
        if (claims.action !== "cancel" && !client) {
          return page(res, 503, "Approval link", '<h1>Not right now</h1><p class="sub">Steering and queueing re-enter the message pipeline, which needs a connected chat client. Only <em>Cancel</em> works while the gateway is disconnected.</p>');
        }
        if (!spendToken(res, claims)) return;
        const outcome = busyThreadChoices.takeAsAdmin(claims.id);
        if (!outcome.ok) return deadEnd(res, "resolved");
        const record = outcome.record;
        const channel = record.channelId || record.event?.channel || "";
        const result = await applyBusyThreadChoice({
          choiceId: claims.id,
          record,
          choice: claims.action,
          client,
          channel,
          messageTs: record.choiceMessageTs || "",
          processMessage,
        });
        retireApprovalLinkTokens(claims.id, now());
        await logEvent("approval_resolved_by_link", {
          channel,
          author: target.requesterId,
          slug: record.slug || "",
          approvalId: claims.id,
          principal: APPROVAL_LINK_PRINCIPAL,
          decision: claims.action,
          scope: "",
          kind: BUSY_THREAD_CHOICE_KIND,
        });
        return page(
          res,
          200,
          "Done",
          `<h1><span class="ok">Done</span></h1><p class="sub">${escapeHtml(approvalLinkActionLabel(claims.action))} — recorded for ${escapeHtml(requesterName)}.</p>` +
            `<p class="note">${escapeHtml(result?.cancelled ? "The waiting message was dropped; the run already in progress keeps going." : "The message was handed back to the conversation.")} You can close this page.</p>`,
        );
      }

      const decision = claims.action === "deny" ? "deny" : "approve";
      if (!spendToken(res, claims)) return;
      const result = await applyApprovalDecision({
        id: claims.id,
        entry: target.entry,
        durable: target.durable,
        decision,
        scope: decision === "approve" ? claims.scope || "once" : "once",
        // `decided_by` reads "link"; the card names the person the link was minted for.
        actorId: APPROVAL_LINK_PRINCIPAL,
        actorLabel: `${target.requesterId ? `<@${target.requesterId}>` : requesterName} (approval link)`,
        client,
      });
      if (!result.ok && result.code !== 502) {
        return page(res, result.code || 400, "Approval link", `<h1><span class="bad">Not applied</span></h1><p class="sub">${escapeHtml(result.error || "This request could not be resolved.")}</p>`);
      }
      // Every other link for this request dies with it — a live "deny" URL after an approval is
      // the link equivalent of a dead button that still fires.
      retireApprovalLinkTokens(claims.id, now());
      await logEvent("approval_resolved_by_link", {
        channel: target.entry.channelId || "",
        author: target.requesterId,
        slug: target.entry.slug || "",
        approvalId: claims.id,
        principal: APPROVAL_LINK_PRINCIPAL,
        decision: result.decision || decision,
        scope: result.scope || "",
        tool: target.entry.toolName || "",
        durable: Boolean(target.durable),
        ...(result.ok ? {} : { started: false, error: String(result.error || "").slice(0, 240) }),
      });
      if (!result.ok) {
        return page(res, 502, "Approval link", `<h1><span class="bad">Approved, but it could not start</span></h1><p class="sub">${escapeHtml(String(result.error || "The approved job could not start."))}</p><p class="note">The approval itself is consumed and cannot be replayed.</p>`);
      }
      return page(
        res,
        200,
        "Done",
        `<h1><span class="${decision === "approve" ? "ok" : "bad"}">${decision === "approve" ? "Approved" : "Denied"}</span></h1>` +
          `<p class="sub">${escapeHtml(approvalLinkActionLabel(claims.action, claims.scope))} — recorded for ${escapeHtml(requesterName)}.</p>` +
          `<p class="note">The card in the conversation has been updated${target.entry.toolName ? ` for <strong>${escapeHtml(target.entry.toolName)}</strong>` : ""}. You can close this page.</p>`,
      );
    } catch (e) {
      next(e);
    }
  });

  return router;
}
