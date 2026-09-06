// Link-based approvals — the platform-neutral half of "someone has to say yes".
//
// Slack's Block Kit buttons are the nicest way to answer an approval card, and they stay exactly
// as they were. They are also the ONLY way, which is a problem the moment the conversation is on
// a surface whose interactive primitive we do not drive (Microsoft Teams and Google Chat today
// name the actions in text and have no click to give), and it is a problem for automation and QA,
// which cannot click anything at all. A signed URL works everywhere a message can carry a link.
//
// The shape of the thing:
//
//   token   = "1.<approvalId>.<action>.<scope>.<expiry base36>.<nonce>.<HMAC-SHA256/128 b64url>"
//   link    = <publicUrl>/approve/<token>
//   GET     renders a confirmation page and changes NOTHING
//   POST    performs the decision, exactly once
//
// Three properties are load-bearing and each exists for a specific failure:
//
//  1. The HMAC covers the id, the action, the scope AND the expiry, so a recipient cannot promote
//     their own "deny" link into an "approve for this channel forever" one by editing the URL.
//     Verification is constant-time.
//  2. The nonce is recorded in `approval_link_tokens` at mint time and spent by one atomic UPDATE,
//     so a link works exactly once even though Slack, mail clients and corporate proxies happily
//     copy URLs around and retry them.
//  3. GET never acts. Slack unfurls links, Teams' link preview service fetches them, and scanning
//     proxies pre-open everything in an inbound message — a GET with a side effect would mean the
//     unfurler approves the request before the human sees it.
//
// This module is deliberately free of any chat/HTTP dependency: it mints, it verifies, it builds
// URLs. The Express surface is src/web/routes/approve.js; delivery is the caller's business
// (src/slack/approvals.js posts the links as an ephemeral to the requester).
import crypto from "node:crypto";

import { getApprovalLinks, getPublicUrl } from "../config/settings.js";
import { recordApprovalLinkToken } from "../gateway/approval-link-tokens.js";

// A link lives as long as the card it belongs to plus a little slack for a person who is reading
// their notifications. Volatile permission cards expire after 4 minutes on their own; durable
// background-shell rows never expire, but a bearer link that never expires is a credential nobody
// can revoke, so links get their own ceiling regardless.
export const APPROVAL_LINK_TTL_MS = 30 * 60 * 1000;

// What a link may do, per kind of card. `scope` only means something for a permission approval.
export const APPROVAL_LINK_KINDS = Object.freeze(["approval", "thread_choice"]);
export const APPROVAL_LINK_ACTIONS = Object.freeze(["approve", "deny", "steer", "queue", "cancel"]);
export const APPROVAL_LINK_SCOPES = Object.freeze(["", "once", "thread", "forever"]);

const SEP = ".";
const TOKEN_VERSION = "1";
// A 128-bit tag is the standard truncation for HMAC-SHA256 and keeps the URL short enough to read
// aloud. Truncation does not weaken the forgery bound that matters here.
const TAG_BYTES = 16;
const NONCE_BYTES = 9; // 12 base64url characters

const b64 = (buf) => Buffer.from(buf).toString("base64url");

function secretOf(explicit) {
  const secret = String(explicit || process.env.CG_APPROVAL_SECRET || "");
  if (!secret) throw new Error("no CG_APPROVAL_SECRET — approval links cannot be signed");
  return secret;
}

// The signed payload is the token minus its tag, so a verifier re-signs exactly the bytes it read
// rather than a re-serialization of them (a re-serialization is where a canonicalization bug and
// therefore a signature bypass would live).
function sign(payload, secret) {
  return b64(crypto.createHmac("sha256", secretOf(secret)).update(payload).digest().subarray(0, TAG_BYTES));
}

// Field values may not contain the separator; ids are UUIDs and actions/scopes come from the
// closed lists above, so this is an assertion about our own callers rather than input validation.
function field(value, name) {
  const text = String(value ?? "");
  if (text.includes(SEP)) throw new Error(`approval link ${name} may not contain "${SEP}"`);
  return text;
}

export function mintApprovalLinkToken({
  id,
  kind = "approval",
  action,
  scope = "",
  expiresAt,
  nonce = b64(crypto.randomBytes(NONCE_BYTES)),
  secret = "",
} = {}) {
  if (!id) throw new Error("approval link needs an approval id");
  if (!APPROVAL_LINK_KINDS.includes(kind)) throw new Error(`unknown approval link kind: ${kind}`);
  if (!APPROVAL_LINK_ACTIONS.includes(action)) throw new Error(`unknown approval link action: ${action}`);
  if (!APPROVAL_LINK_SCOPES.includes(scope)) throw new Error(`unknown approval link scope: ${scope}`);
  const expiry = Number(expiresAt) || Date.now() + APPROVAL_LINK_TTL_MS;
  const payload = [
    TOKEN_VERSION,
    field(id, "id"),
    kind === "approval" ? "a" : "t",
    action,
    scope,
    Math.floor(expiry).toString(36),
    field(nonce, "nonce"),
  ].join(SEP);
  return { token: `${payload}${SEP}${sign(payload, secret)}`, nonce, expiresAt: expiry, id: String(id), kind, action, scope };
}

// Verify signature + expiry and hand back the claims. Never touches the database: single-use is a
// separate, deliberately explicit step (inspect for a GET, consume for a POST), because the one
// thing this function must never do is have a side effect on a page load.
export function verifyApprovalLinkToken(token, { secret = "", now = Date.now() } = {}) {
  const raw = String(token ?? "");
  // Bound the work a stranger can make us do, and keep the character set to what we mint.
  if (!raw || raw.length > 400 || !/^[A-Za-z0-9._-]+$/.test(raw)) return { ok: false, reason: "malformed" };
  const cut = raw.lastIndexOf(SEP);
  if (cut <= 0) return { ok: false, reason: "malformed" };
  const payload = raw.slice(0, cut);
  const tag = raw.slice(cut + 1);
  const parts = payload.split(SEP);
  if (parts.length !== 7) return { ok: false, reason: "malformed" };
  const [version, id, kindCode, action, scope, expiry36, nonce] = parts;
  if (version !== TOKEN_VERSION) return { ok: false, reason: "malformed" };

  let expected;
  try {
    expected = sign(payload, secret);
  } catch {
    return { ok: false, reason: "unsigned" };
  }
  // Constant-time, and over equal-length Buffers: a length check first would leak the tag length,
  // and timingSafeEqual throws on a mismatch.
  const a = Buffer.from(tag);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad-signature" };

  const kind = kindCode === "a" ? "approval" : kindCode === "t" ? "thread_choice" : "";
  if (!kind || !APPROVAL_LINK_ACTIONS.includes(action) || !APPROVAL_LINK_SCOPES.includes(scope) || !id || !nonce) {
    return { ok: false, reason: "malformed" };
  }
  const expiresAt = Number.parseInt(expiry36, 36);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "malformed" };
  if (expiresAt <= now) return { ok: false, reason: "expired", claims: { id, kind, action, scope, nonce, expiresAt } };
  return { ok: true, claims: { id, kind, action, scope, nonce, expiresAt } };
}

// ── Where a link points ─────────────────────────────────────────────────────────
// `publicUrl` is the operator's externally reachable base URL. Without one there is nowhere for a
// person outside this machine to click, which is why `auto` will not put links in a Slack thread
// that already has working buttons. `always` falls back to the loopback address so an operator (or
// a test) on this host still gets a usable link.
export function localBaseUrl() {
  return `http://127.0.0.1:${process.env.PORT || 4747}`;
}

export function approvalLinkUrl(baseUrl, token) {
  let base;
  try {
    base = new URL(String(baseUrl || ""));
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return "";
  base.search = "";
  base.hash = "";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/approve/${token}`;
  return base.toString();
}

// Should this conversation get links at all, and from which base URL? One function so the Slack
// path, the busy-thread path and the Settings copy can never disagree about what `auto` means.
//
//   off     — never.
//   auto    — a platform whose buttons we actually drive (Slack) gets links only as an ADDITION,
//             and only once `publicUrl` is set; a platform without working buttons gets them from
//             whatever base URL exists, because there they are the only way to decide.
//   always  — links wherever a base URL can be built, loopback included.
export function approvalLinkBase({ mode = getApprovalLinks(), capabilities = null, publicUrl = getPublicUrl() } = {}) {
  if (mode === "off") return "";
  const nativeButtons = Boolean(capabilities?.buttons) && capabilities?.richCards === "block-kit";
  if (mode === "auto" && nativeButtons) return publicUrl || "";
  return publicUrl || localBaseUrl();
}

// ── The set of links one card offers ────────────────────────────────────────────
// `choices` is [{ action, scope, label }]. Each becomes a minted token, a recorded nonce and a
// URL. A choice whose URL cannot be built (no base) is dropped rather than rendered dead.
export function buildApprovalLinks({ baseUrl, id, kind = "approval", requester = "", choices = [], now = Date.now(), ttlMs = APPROVAL_LINK_TTL_MS, secret = "" } = {}) {
  if (!baseUrl || !id || !choices.length) return [];
  const expiresAt = now + Math.max(1, Number(ttlMs) || APPROVAL_LINK_TTL_MS);
  const links = [];
  for (const choice of choices) {
    let minted;
    try {
      minted = mintApprovalLinkToken({ id, kind, action: choice.action, scope: choice.scope || "", expiresAt, secret });
    } catch {
      continue; // an unsignable or malformed choice must not take the rest of the card with it
    }
    const url = approvalLinkUrl(baseUrl, minted.token);
    if (!url) continue;
    try {
      recordApprovalLinkToken({
        nonce: minted.nonce,
        approvalId: String(id),
        kind,
        action: choice.action,
        scope: choice.scope || "",
        requester: String(requester || ""),
        expiresAt,
      });
    } catch {
      continue; // no durable single-use guarantee → no link, rather than a replayable one
    }
    links.push({ action: choice.action, scope: choice.scope || "", label: choice.label || choice.action, url, expiresAt });
  }
  return links;
}

// The ephemeral body. Deliberately one line per choice with the raw URL visible: an approval link
// is a thing you decide to click, and a link whose destination is hidden behind display text is
// exactly the shape of a phishing message.
export function approvalLinksMessage({ toolName = "", links = [], expiresAt = 0, native = true, now = Date.now() } = {}) {
  if (!links.length) return "";
  const minutes = expiresAt ? Math.max(1, Math.round((expiresAt - now) / 60000)) : Math.round(APPROVAL_LINK_TTL_MS / 60000);
  const head = native
    ? `🔗 *${toolName || "Approval"}* — you can also decide this from a browser (the buttons in the thread still work):`
    : `🔗 *${toolName || "Approval"}* — decide this from a browser:`;
  const body = links.map((link) => `• *${link.label}* — ${link.url}`).join("\n");
  return `${head}\n${body}\n_Each link opens a confirmation page, works once, and expires in about ${minutes} minutes. Only you can see this message — don't forward these links._`;
}
