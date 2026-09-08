// Permission approvals (extracted from slack/app.js — the 2026-08 restructure notes (internal repo) Phase 2.2).
// A non-admin run can hit a tool that needs permission. Claude's --permission-prompt-tool then
// calls our MCP `permission_prompt` tool, which POSTs to /internal/approval → requestApproval()
// here: we post Approve/Deny buttons in the thread and resolve the awaiting MCP call (→ Claude)
// when an authorized person clicks. "Approve for this thread" remembers the tool so a multi-step
// task isn't re-prompted for the same kind of action.
import { randomUUID } from "node:crypto";

import { logEvent } from "../util/logger.js";
import { getChannelMeta, patchChannelMeta, isAdmin, isApproved } from "../config/store.js";
import { effectiveMeta } from "../gateway/run.js";
import { canManage, isAuthorized } from "../gateway/modes.js";
import { toolTarget } from "../engines/stream.js";
import {
  approvalActionKey,
  createApprovalRequest,
  deleteApprovalRequest,
  findPendingApproval,
  getApprovalRequest,
  listPendingApprovalRequests,
  patchPendingApproval,
  transitionApprovalRequest,
} from "../gateway/approval-requests.js";
import { retireApprovalLinkTokens } from "../gateway/approval-link-tokens.js";
import { approvalLinkBase, approvalLinksMessage, buildApprovalLinks } from "../web/approval-links.js";
import { slackAdapter } from "../platforms/slack.js";
import { postPrivately } from "../platforms/notify.js";

// The live Slack client of the currently-connected app (set from connectAndWire); the approval
// flow is driven by the daemon's /internal/approval route rather than an event, so it can't take
// the client from a Bolt handler argument.
let currentClient = null;
export function setApprovalClient(client) {
  currentClient = client;
}

// Registered by server.js after BackgroundJobs is constructed. Durable approval rows contain
// only the exact narrow action; the executor re-validates live channel mode/identity before spawn.
let durableApprovalExecutor = null;
export function setDurableApprovalExecutor(executor) {
  durableApprovalExecutor = typeof executor === "function" ? executor : null;
}

// ── Permission approvals (interactive buttons) ──────────────────────────────────
// A non-admin run can hit a tool that needs permission. Claude's --permission-prompt-tool then
// calls our MCP `permission_prompt` tool, which POSTs to /internal/approval → requestApproval()
// here: we post Approve/Deny buttons in the thread and resolve the awaiting MCP call (→ Claude)
// when an authorized person clicks. "Approve for this thread" remembers the tool so a multi-step
// task isn't re-prompted for the same kind of action.
const pendingApprovals = new Map(); // id -> { finish, channelId, msgTs, runKey, toolName, authorId, approvalType }
const threadAllow = new Map(); // runKey -> Set(toolName) pre-approved for the rest of the thread
export const APPROVAL_ACTIONS = ["cg_approve_once", "cg_approve_thread", "cg_approve_always", "cg_approve", "cg_deny", "cg_approval_comment"];
const APPROVAL_TIMEOUT_MS = 4 * 60 * 1000;

// How far an "approve" reaches. A Slack button carries it in its action_id; the admin HTTP API
// carries it in the request body. Both hand the same value to applyApprovalDecision().
export const APPROVAL_SCOPES = ["once", "thread", "forever"];
// Remembered grants apply only to native tool permissions. Plans and durable actions
// require a decision about this exact request, even when their titles match an earlier one.
export function approvalScopesFor({ approvalType, durable = false } = {}) {
  return approvalType === "permission" && !durable ? [...APPROVAL_SCOPES] : ["once"];
}
const SCOPE_BY_ACTION = {
  cg_approve: "once",
  cg_approve_once: "once",
  cg_approve_thread: "thread",
  cg_approve_always: "forever",
};

// A bounded memory of the approvals this process has already decided. The volatile map deletes an
// entry the moment it resolves, so without this an id that was just approved is indistinguishable
// from one that never existed — and the HTTP API has to answer 409 (already resolved) rather than
// 404 (unknown). Never consulted for authorization; it holds no request detail.
const RESOLVED_MEMORY = 500;
const resolvedApprovals = new Map(); // id -> { at, decision, scope }
function rememberResolved(id, info = {}) {
  if (!id) return;
  const key = String(id);
  resolvedApprovals.delete(key);
  resolvedApprovals.set(key, { at: Date.now(), ...info });
  while (resolvedApprovals.size > RESOLVED_MEMORY) resolvedApprovals.delete(resolvedApprovals.keys().next().value);
  // The card is answered, so every UNUSED approval link for it dies with it — whichever surface
  // answered it. A live "Deny" URL sitting in someone's ephemeral after the request was approved
  // is the link equivalent of a dead button that still fires.
  try {
    retireApprovalLinkTokens(key);
  } catch {
    /* best-effort: a decision must never fail because the link ledger is unavailable */
  }
}

// The preview is model-controlled text inside a mrkdwn fence: a ``` in the content would close
// the fence early and let the remainder render as styled prose (disguising what's approved), and
// silent clipping would let a long command's tail execute unseen. Break embedded fences with a
// zero-width space and always SAY when content was cut.
const PREVIEW_MAX = 2800;
function fencedPreview(raw) {
  if (!raw) return "";
  const text = String(raw);
  const safe = text.slice(0, PREVIEW_MAX).replaceAll("```", "`​`​`");
  const hidden = text.length - PREVIEW_MAX;
  return `\n\`\`\`${safe}\`\`\`${hidden > 0 ? `\n⚠️ _+${hidden} more characters NOT shown above._` : ""}`;
}

// Session-key → real Slack thread resolution now lives in slack/thread-keys.js so the MCP tool
// servers (separate processes, which must not import this module's run/engine graph) apply the
// identical rule. Re-exported here because this is where callers and tests already look for it:
// posting an unresolved key as thread_ts is what made every scheduled/background-agent approval
// card fail to appear.
export { isSlackTs, slackThreadFor } from "./thread-keys.js";
import { isSlackTs, slackThreadFor } from "./thread-keys.js";

function approvalBlocks(id, toolName, target, authorId, { approvalType = "permission", approveText = "Approve", denyText = "Deny", durable = false } = {}) {
  const preview = fencedPreview(target);
  if (approvalType === "agent") {
    return [
      { type: "section", text: { type: "mrkdwn", text: `*${toolName}*${preview}\n<@${authorId}> asked for approval${durable ? ". This exact request remains actionable across gateway restarts until handled." : " before continuing."}` } },
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: approveText.slice(0, 75) || "Approve" }, action_id: "cg_approve", value: id },
          { type: "button", style: "danger", text: { type: "plain_text", text: denyText.slice(0, 75) || "Deny" }, action_id: "cg_deny", value: id },
          { type: "button", text: { type: "plain_text", text: "Comment" }, action_id: "cg_approval_comment", value: id },
        ],
      },
    ];
  }
  return [
    { type: "section", text: { type: "mrkdwn", text: `🔒 *Permission needed* — \`${toolName}\`${preview}\n<@${authorId}>'s request wants to do this. Approve?` } },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve once" }, action_id: "cg_approve_once", value: id },
        { type: "button", text: { type: "plain_text", text: "Approve for this thread" }, action_id: "cg_approve_thread", value: id },
        { type: "button", text: { type: "plain_text", text: "Approve forever" }, action_id: "cg_approve_always", value: id },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" }, action_id: "cg_deny", value: id },
      ],
    },
  ];
}

// Post one approval card and return the message ts the decision is anchored to. `threadTs` null
// posts TOP-LEVEL, which is what turns a synthetic session key into a real, replyable thread.
// Fails loudly when Slack answers without a usable ts: an un-updatable card is a request nobody
// can ever resolve or expire, and swallowing that is how scheduled approvals went missing.
async function postApprovalCard(client, { channelId, threadTs, text, blocks, context = {} }) {
  const posted = await client.chat.postMessage({ channel: channelId, thread_ts: threadTs || undefined, text, blocks });
  const ts = posted?.ts;
  if (!isSlackTs(ts)) {
    await logEvent("approval_post_bad_ts", { channel: channelId, ts: String(ts ?? ""), ...context }).catch(() => {});
    throw new Error(`Slack returned no usable message ts for the approval card (got ${JSON.stringify(ts ?? null)})`);
  }
  return ts;
}

// ── The same card, as links ─────────────────────────────────────────────────────
// Signed, single-use URLs are the platform-neutral form of this card: they work on a surface whose
// buttons the gateway does not drive (Teams, Google Chat), and they let automation and QA get past
// a permission prompt that otherwise needs a human in a Slack client. On Slack they are strictly
// ADDITIONAL — the Block Kit buttons are unchanged and remain the primary control.
//
// A link is a bearer credential, so the set of links is exactly the set of decisions the RECIPIENT
// could make by clicking: `canResolveApproval` is the same authority function the button handler
// runs, and it is run again on every POST. Nothing is minted that the requester could not click,
// which is why an admin-tier control-plane sign-off gets a Deny link and no Approve link at all.
// "Comment" has no link: it needs free text, and a one-button confirmation page cannot carry it.
async function approvalLinkChoices(entry, { durable = false, approveText = "Approve", denyText = "Deny" } = {}) {
  const requester = entry.authorId || "";
  if (!requester) return [];
  let authority;
  try {
    authority = await canResolveApproval(entry, requester);
  } catch {
    return [];
  }
  if (!authority.allowed) return [];
  const choices = [];
  if (authority.meetsTier) {
    if (entry.approvalType === "permission" && !durable) {
      choices.push({ action: "approve", scope: "once", label: "Approve once" });
      choices.push({ action: "approve", scope: "thread", label: "Approve for this thread" });
      // Persisting a forever-approval changes the channel's security posture — admins only, on a
      // link exactly as on the button.
      if (authority.clickerIsAdmin) choices.push({ action: "approve", scope: "forever", label: "Approve forever (this channel)" });
    } else {
      choices.push({ action: "approve", scope: "once", label: approveText || "Approve" });
    }
  }
  choices.push({ action: "deny", scope: "", label: denyText || "Deny" });
  return choices;
}

// Mint the links for one card and hand them to the requester privately (Slack ephemeral in the
// same thread; a DM on a surface with no ephemeral). Best-effort by design: a card that posted is
// answerable by its buttons, so a failure here must never fail the approval.
async function deliverApprovalLinks(client, entry, { id, threadKey, durable = false, approveText, denyText } = {}) {
  try {
    const baseUrl = approvalLinkBase({ capabilities: slackAdapter.capabilities, requester: entry.authorId });
    if (!baseUrl || !client) return [];
    const choices = await approvalLinkChoices(entry, { durable, approveText, denyText });
    if (!choices.length) return [];
    const links = buildApprovalLinks({ baseUrl, id, kind: "approval", requester: entry.authorId || "", choices });
    if (!links.length) return [];
    const text = approvalLinksMessage({ toolName: entry.toolName || "", links, expiresAt: links[0].expiresAt });
    await postPrivately(client, {
      conversationId: entry.channelId,
      threadKey: slackThreadFor(threadKey) || "",
      userId: entry.authorId,
      text,
    });
    return links;
  } catch {
    return []; // the buttons still work; a link is an addition, never a precondition
  }
}

// Called by the daemon's /internal/approval route. Posts buttons, returns { allow, reason } once
// resolved (click or timeout). Pre-approves via the per-thread cache without re-asking.
export async function requestApproval(slack, { channelId, slug, authorId, threadKey, toolName, toolInput, approvalType = "permission", approveText = "Approve", denyText = "Deny", requiredTier = "", durableAction = null } = {}) {
  const client = slack?.getClient?.() || currentClient;
  const durable = durableAction?.kind === "background_shell";
  if (!channelId || !threadKey) return { allow: false, reason: "gateway can't reach Slack to ask for approval" };
  const runKey = `${slug}::${threadKey}`;
  // Auto mode → approve without asking; tools "approved forever" here → likewise. Still sandboxed.
  if (approvalType === "permission") {
    try {
      const meta = effectiveMeta((await getChannelMeta(slug)) || {});
      if (meta.autoMode) return { allow: true, reason: "auto mode (auto-approved)" };
      // Admin outranks auto (run.js adminUnattendedTier): the admin's own runs in an adminMode
      // channel behave at least like auto mode, so their unattended turns don't stall on a click
      // nobody sees. Non-admin authors in the same channel still get buttons.
      if (meta.adminMode && authorId && (await isAdmin(authorId))) {
        return { allow: true, reason: "admin mode (auto-approved for the admin author)" };
      }
      if ((meta.approvedTools || []).includes(toolName)) return { allow: true, reason: "approved forever for this channel" };
    } catch {
      /* fall through to buttons */
    }
    if (threadAllow.get(runKey)?.has(toolName)) return { allow: true, reason: "pre-approved for this thread" };
  }

  let target = "";
  try {
    // Agent approvals carry the full plan/action text in `details` — show it (the card slices to
    // 2800). toolTarget()'s 60-char preview is for short tool-call previews, not sign-off context.
    target = approvalType === "agent" ? String(toolInput?.details || "") : toolTarget(toolName, toolInput) || "";
  } catch {
    /* best-effort preview */
  }
  // Durable shell approvals do not hold the engine/MCP HTTP request open. Persist the exact
  // authority-bearing action, post one reusable card, and return immediately. A click — including
  // after a daemon restart — loads the row and invokes the daemon executor directly.
  if (durable) {
    const actionKey = approvalActionKey(durableAction);
    const existing = findPendingApproval(actionKey);
    if (existing) {
      // A crash between INSERT and postMessage can leave a valid row without a visible card.
      // Re-post the same id on the next identical request. A crash after Slack accepted the post
      // but before msgTs was patched may create two cards; the SQLite CAS still lets only one win.
      if (!existing.msgTs && client) {
        try {
          const ts = await postApprovalCard(client, {
            channelId: existing.channelId,
            threadTs: slackThreadFor(existing.action?.threadKey || threadKey),
            text: `Approval requested: ${existing.toolName}`,
            blocks: approvalBlocks(existing.id, existing.toolName, existing.target, existing.authorId, {
              approvalType: existing.approvalType,
              approveText: existing.approveText,
              denyText: existing.denyText,
              durable: true,
            }),
            context: { approvalId: existing.id, toolName: existing.toolName },
          });
          patchPendingApproval(existing.id, { msgTs: ts });
        } catch {
          return { allow: false, pending: true, approvalId: existing.id, reason: "approval is saved but Slack couldn't restore its card yet" };
        }
      }
      return {
        allow: false,
        pending: true,
        approvalId: existing.id,
        reason: "approval is still pending; the existing Run it button remains active",
      };
    }
    if (!client) return { allow: false, reason: "gateway can't reach Slack to ask for approval" };
    const id = randomUUID();
    try {
      createApprovalRequest({
        id,
        actionKey,
        status: "pending",
        channelId,
        msgTs: "",
        runKey,
        slug,
        toolName,
        authorId,
        approvalType,
        requiredTier,
        target,
        approveText,
        denyText,
        action: durableAction,
      });
    } catch (error) {
      // A concurrent duplicate insert loses the partial-unique-index race; reuse the winner.
      const winner = findPendingApproval(actionKey);
      if (winner) return { allow: false, pending: true, approvalId: winner.id, reason: "approval is already pending" };
      return { allow: false, reason: `couldn't persist the approval request: ${error.message}` };
    }
    try {
      const ts = await postApprovalCard(client, {
        channelId,
        threadTs: slackThreadFor(threadKey),
        text: `Approval requested: ${toolName}`,
        blocks: approvalBlocks(id, toolName, target, authorId, { approvalType, approveText, denyText, durable: true }),
        context: { approvalId: id, toolName, slug },
      });
      patchPendingApproval(id, { msgTs: ts });
    } catch (error) {
      deleteApprovalRequest(id);
      return { allow: false, reason: `couldn't post the approval prompt: ${error.message}` };
    }
    await deliverApprovalLinks(client, { channelId, slug, authorId, toolName, approvalType, requiredTier }, {
      id,
      threadKey,
      durable: true,
      approveText,
      denyText,
    });
    return {
      allow: false,
      pending: true,
      approvalId: id,
      reason: "approval saved; click Run it now or after a gateway restart",
    };
  }

  if (!client) return { allow: false, reason: "gateway can't reach Slack to ask for approval" };
  const id = randomUUID();
  let msgTs = null;
  try {
    msgTs = await postApprovalCard(client, {
      channelId,
      threadTs: slackThreadFor(threadKey),
      text: approvalType === "agent" ? `Approval requested: ${toolName}` : `🔒 Permission needed: ${toolName}`,
      blocks: approvalBlocks(id, toolName, target, authorId, { approvalType, approveText, denyText }),
      context: { approvalId: id, toolName, slug },
    });
  } catch (error) {
    return { allow: false, reason: `couldn't post the approval prompt: ${error.message}` };
  }
  const createdAt = Date.now();
  return new Promise((resolve) => {
    const finish = (decision) => {
      if (!pendingApprovals.has(id)) return;
      clearTimeout(timer);
      pendingApprovals.delete(id);
      resolve(decision);
    };
    const timer = setTimeout(() => {
      finish({ allow: false, reason: "approval timed out (no one clicked)" });
      // Best-effort: flip the card so dead buttons can't be mistaken for a live request. The
      // deny itself already surfaced in-thread via the tool's refusal reply.
      client.chat
        .update({ channel: channelId, ts: msgTs, text: "Approval expired", blocks: [{ type: "section", text: { type: "mrkdwn", text: `⏱ *${toolName}* — nobody clicked within ${Math.round(APPROVAL_TIMEOUT_MS / 60000)} minutes; the request was refused.` } }] })
        .catch(() => {});
    }, APPROVAL_TIMEOUT_MS);
    timer.unref?.();
    pendingApprovals.set(id, {
      finish,
      channelId,
      msgTs,
      runKey,
      slug,
      threadKey,
      toolName,
      target,
      authorId,
      approvalType,
      requiredTier,
      createdAt,
      expiresAt: createdAt + APPROVAL_TIMEOUT_MS,
    });
    // Deliberately NOT awaited, and deliberately after pendingApprovals.set: the entry has to
    // exist the instant the card does, or a click landing in the gap between the two would find
    // no request and answer "already handled" while the run waits forever. The links are an
    // addition to a card that already works.
    void deliverApprovalLinks(client, { channelId, slug, authorId, toolName, approvalType, requiredTier }, { id, threadKey, approveText, denyText });
  });
}

// ── One lookup, two homes ───────────────────────────────────────────────────────
// An approval lives either in the in-memory long-poll map (a permission or control-plane card
// whose MCP call is still open) or in the durable `approval_requests` row (a background-shell
// action that outlives the process). `entry` is set only while the request is still decidable;
// `resolved` separates "already decided" from "never existed" so the HTTP API can answer 409 vs
// 404 — and so the Slack card can say which happened.
export function lookupApproval(id) {
  const key = String(id ?? "");
  const volatileEntry = pendingApprovals.get(key);
  const persisted = volatileEntry ? null : getApprovalRequest(key);
  const durable = Boolean(persisted?.action?.kind === "background_shell");
  const record = volatileEntry || persisted || null;
  const live = Boolean(record) && (!durable || record.status === "pending");
  return {
    entry: live ? record : null,
    record,
    durable,
    resolved: Boolean((record && !live) || resolvedApprovals.has(key)),
  };
}

const summarize = (text, max = 400) => {
  const value = String(text ?? "");
  return { summary: value.slice(0, max), summaryTruncated: value.length > max };
};

// Everything still awaiting a decision, newest first, in one secret-free shape. Deliberately built
// field by field: the volatile entry holds the `finish` continuation and the durable row holds the
// full authority-bearing action (command, workDir, caps) — neither may leak into an HTTP response.
// The command/plan PREVIEW is the same text the Slack card already shows in the thread.
export function listPendingApprovals() {
  const rows = [];
  for (const [id, entry] of pendingApprovals) {
    rows.push({
      id,
      durable: false,
      kind: entry.approvalType === "permission" ? "permission" : "agent",
      approvalType: entry.approvalType || "permission",
      channelId: entry.channelId || "",
      slug: entry.slug || "",
      threadKey: entry.threadKey || "",
      messageTs: entry.msgTs || "",
      requesterId: entry.authorId || "",
      tool: entry.toolName || "",
      label: "",
      requiredTier: entry.requiredTier || "",
      createdAt: entry.createdAt || 0,
      expiresAt: entry.expiresAt || null,
      ...summarize(entry.target),
    });
  }
  for (const row of listPendingApprovalRequests()) {
    rows.push({
      id: row.id,
      durable: true,
      kind: row.action?.kind || "background_shell",
      approvalType: row.approvalType || "agent",
      channelId: row.channelId || "",
      slug: row.slug || "",
      threadKey: row.action?.threadKey || "",
      messageTs: row.msgTs || "",
      requesterId: row.authorId || "",
      tool: row.toolName || "",
      label: row.action?.label || "",
      requiredTier: row.requiredTier || "",
      createdAt: row.createdAt || 0,
      // Durable approvals deliberately never expire: the whole point is that the button still
      // works after a restart.
      expiresAt: null,
      ...summarize(row.target),
    });
  }
  return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// ── The decision itself ─────────────────────────────────────────────────────────
// Shared by the Slack button handler and the admin HTTP API. Everything AFTER "who may decide
// this" happens here exactly once — scope semantics (once / thread / forever), the durable
// executor and its state machine, releasing the waiting MCP call, and the card update — so
// resolving from the admin UI is the same event as a click, with a different principal on the
// card and in the audit trail. Callers own their own refusal surface (an ephemeral vs an HTTP
// status), which is why this returns a code instead of posting one.
export async function applyApprovalDecision({
  id,
  entry,
  durable = false,
  decision,
  scope = "once",
  actorId = "",
  actorLabel = "",
  comment = "",
  client = null,
  messageTs = "",
} = {}) {
  if (!entry) return { ok: false, code: 404, error: "no such approval" };
  // A comment is a request for CHANGES: it never approves, whichever button carried it.
  const approve = decision === "approve" && !comment;
  if (approve && !approvalScopesFor({ approvalType: entry.approvalType, durable }).includes(scope)) {
    return { ok: false, code: 400, error: "Approval scope is not supported for this request." };
  }
  const who = actorLabel || (actorId ? `<@${actorId}>` : "the admin UI");
  const cardTs = entry.msgTs || messageTs;
  const reason = comment ? `Changes requested by ${who}` : approve ? `Approved by ${who}` : `Denied by ${who}`;
  const updateCard = async (text, blocks) => {
    if (!client?.chat?.update || !entry.channelId || !cardTs) return;
    try {
      await client.chat.update({ channel: entry.channelId, ts: cardTs, text, blocks });
    } catch {
      /* message gone */
    }
  };
  const commentBlocks = () => [
    { type: "section", text: { type: "mrkdwn", text: `💬 *${entry.toolName}* — changes requested by ${who}:\n>${comment.replace(/\n/g, "\n>")}` } },
  ];

  if (durable) {
    if (!approve) {
      const denied = transitionApprovalRequest(id, "pending", "denied", { decidedBy: actorId, reason, ...(comment ? { comment } : {}) });
      if (!denied) return { ok: false, code: 409, error: "this approval was already handled" };
      rememberResolved(id, { decision: "deny", scope: "" });
      if (comment) await updateCard("Resolved", commentBlocks());
      else await updateCard("Denied", [{ type: "section", text: { type: "mrkdwn", text: `🔒 *${entry.toolName}* — 🚫 ${reason}.` } }]);
      return { ok: true, decision: "deny", scope: "", outcome: reason };
    }
    if (typeof durableApprovalExecutor !== "function") {
      return { ok: false, code: 503, error: "The gateway cannot start durable approvals right now. This request remains pending; try again after a restart." };
    }
    const claimed = transitionApprovalRequest(id, "pending", "executing", { decidedBy: actorId, reason });
    if (!claimed) return { ok: false, code: 409, error: "this approval was already handled" };
    let result;
    try {
      result = await durableApprovalExecutor(claimed);
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    if (result?.ok) {
      transitionApprovalRequest(id, "executing", "consumed", {
        jobId: result.id || "",
        jobLabel: result.label || claimed.action?.label || "background job",
      });
      rememberResolved(id, { decision: "approve", scope: "once" });
      const blocks = [
        { type: "section", text: { type: "mrkdwn", text: `🔒 *${entry.toolName}* — ✅ Approved by ${who} and started *${result.label || "background job"}*. This exact approval is now consumed.` } },
      ];
      if (result.id) {
        blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Check status" }, action_id: "cg_bgjob_status", value: result.id }] });
      }
      await updateCard("Approved and started", blocks);
      return { ok: true, decision: "approve", scope: "once", outcome: reason, jobId: result.id || "", jobLabel: result.label || claimed.action?.label || "" };
    }
    transitionApprovalRequest(id, "executing", "failed", { error: String(result?.error || "the job could not be started").slice(0, 500) });
    rememberResolved(id, { decision: "approve", scope: "once" });
    await updateCard("Approved action could not start", [
      { type: "section", text: { type: "mrkdwn", text: `⚠️ *${entry.toolName}* was approved by ${who}, but the exact job could not start: ${String(result?.error || "unknown error").slice(0, 500)}` } },
    ]);
    return { ok: false, code: 502, decision: "approve", started: false, error: String(result?.error || "the approved job could not start") };
  }

  // Volatile (long-poll) approval: apply the scope, then release the waiting MCP call.
  if (approve && scope === "thread") {
    if (!threadAllow.has(entry.runKey)) threadAllow.set(entry.runKey, new Set());
    threadAllow.get(entry.runKey).add(entry.toolName);
  } else if (approve && scope === "forever") {
    // Persist: this tool is approved forever in this channel (auto-approved on future prompts).
    try {
      await patchChannelMeta(entry.slug, (meta) => ({
        approvedTools: [...new Set([...(meta?.approvedTools || []), entry.toolName])],
      }));
    } catch {
      /* persist failed — still approve this one */
    }
  }
  entry.finish(
    approve
      ? { allow: true, reason, decidedBy: actorId }
      : { allow: false, reason, decidedBy: actorId, ...(comment ? { comment } : {}) },
  );
  rememberResolved(id, { decision: approve ? "approve" : "deny", scope: approve ? scope : "" });
  if (comment) {
    await updateCard("Resolved", commentBlocks());
  } else {
    const outcome = !approve
      ? `🚫 ${reason}.`
      : scope === "thread"
        ? `✅ ${reason} — won't ask again for \`${entry.toolName}\` in this thread.`
        : scope === "forever"
          ? `✅ ${reason} — \`${entry.toolName}\` is now approved forever in this channel.`
          : `✅ ${reason}.`;
    await updateCard("Resolved", [{ type: "section", text: { type: "mrkdwn", text: `🔒 *${entry.toolName}* — ${outcome}` } }]);
  }
  return { ok: true, decision: approve ? "approve" : "deny", scope: approve ? scope : "", outcome: reason };
}

// Who may decide THIS request, and how far. Exported because it is the one authority rule for an
// approval: the button handler runs it on a click, the link router runs it again on every POST
// (and once more at mint time, so a link that could not be honoured is never handed out).
export async function canResolveApproval(entry, clicker) {
  const clickerIsAdmin = await isAdmin(clicker);
  const clickerIsApproved = await isApproved(clicker);
  const m = await getChannelMeta(entry.slug).catch(() => null);
  const allowed =
    clicker === entry.authorId ||
    clickerIsAdmin ||
    (m ? isAuthorized(m, clicker, Boolean(m.isDM), { isAdminUser: clickerIsAdmin, isApprovedUser: clickerIsApproved }) : false);
  // The gated action's authority tier. Being eligible to click is NOT the same as being allowed
  // to APPROVE: an admin-tier control-plane change (or an unsandboxed shell job) must get its
  // human factor from someone who could have authorized the action themselves — never from a
  // bystander member or per-channel guest, and never via the author's own click.
  const tier = entry.requiredTier || "";
  const meetsTier =
    tier === "admin"
      ? clickerIsAdmin
      : tier === "manage"
        ? clickerIsAdmin || canManage(m || {}, { authorId: clicker, isAdminUser: clickerIsAdmin, isApprovedUser: clickerIsApproved })
        : true;
  return { allowed, clickerIsAdmin, meetsTier, tier };
}

export async function handleApprovalClick({ ack, body, action, client }) {
  await ack();
  const id = action?.value;
  const { entry, durable } = lookupApproval(id);
  const clicker = body?.user?.id;
  const channel = body?.channel?.id;
  const ts = body?.message?.ts;
  if (!entry) {
    try {
      await client.chat.update({ channel, ts, text: "Approval handled", blocks: [{ type: "section", text: { type: "mrkdwn", text: durable ? "✅ _This durable approval was already handled and cannot be used twice._" : "⏱ _This approval expired or was already handled._" } }] });
    } catch {
      /* message gone */
    }
    return;
  }
  // Deciding is scoped to who could have STARTED the run: the run's author plus anyone the
  // channel's own access policy authorizes (same isAuthorized check as message gating — approved
  // members in an access:"approved" channel can approve a teammate's prompt, but in an
  // admins-only/"none" channel a non-admin still can't, because they couldn't run the bot there).
  const { allowed, clickerIsAdmin, meetsTier, tier } = await canResolveApproval(entry, clicker);
  if (!allowed) {
    try {
      await client.chat.postEphemeral({ channel, user: clicker, thread_ts: ts, text: "You're not allowed to approve actions for this run." });
    } catch {
      /* no ephemeral scope — ignore */
    }
    return;
  }
  // Tier applies to APPROVING only — anyone eligible may still Deny or Comment (stopping a job
  // or leaving feedback never escalates anything).
  const isApproveAction = action.action_id !== "cg_deny" && action.action_id !== "cg_approval_comment";
  if (isApproveAction && !meetsTier) {
    try {
      await client.chat.postEphemeral({
        channel,
        user: clicker,
        thread_ts: ts,
        text: `This approval needs ${tier === "admin" ? "a gateway *admin*" : "a channel *manager*"} to click Approve — you can still Deny or Comment.`,
      });
    } catch {
      /* no ephemeral scope — ignore */
    }
    return;
  }
  if (action.action_id === "cg_approval_comment") {
    if (!body?.trigger_id) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "cg_approval_comment_modal",
        private_metadata: id,
        title: { type: "plain_text", text: "Approval comment" },
        submit: { type: "plain_text", text: "Send" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `Send feedback for *${entry.toolName}*.` } },
          {
            type: "input",
            block_id: "comment",
            element: { type: "plain_text_input", action_id: "text", multiline: true },
            label: { type: "plain_text", text: "Comment" },
          },
        ],
      },
    });
    return;
  }
  // Persisting a forever-approval changes the channel's security posture — admins only.
  if (action.action_id === "cg_approve_always" && !clickerIsAdmin) {
    try {
      await client.chat.postEphemeral({ channel, user: clicker, thread_ts: ts, text: "Only admins can approve a tool forever — use *Approve once* or *Approve for this thread*." });
    } catch {
      /* no ephemeral scope — ignore */
    }
    return;
  }
  const deny = action.action_id === "cg_deny";
  // From here the decision is identical to the admin API's: one shared applier owns the scope
  // semantics, the durable state machine and the card update. This handler keeps only the parts
  // that are genuinely Slack-shaped — the ephemeral refusals.
  const result = await applyApprovalDecision({
    id,
    entry,
    durable,
    decision: deny ? "deny" : "approve",
    scope: SCOPE_BY_ACTION[action.action_id] || "once",
    actorId: clicker,
    client,
    messageTs: ts,
  });
  if (!result.ok && result.code === 503) {
    try {
      await client.chat.postEphemeral({ channel, user: clicker, thread_ts: ts, text: "The gateway cannot start durable approvals right now. This request remains pending; try the button again after restart." });
    } catch { /* no ephemeral scope */ }
  }
}

export async function handleApprovalCommentSubmit({ ack, body, view, client }) {
  const id = view?.private_metadata;
  const { entry, durable } = lookupApproval(id);
  const clicker = body?.user?.id;
  const comment = view?.state?.values?.comment?.text?.value?.trim() || "";
  if (!entry) {
    await ack();
    return;
  }
  if (!comment) {
    await ack({ response_action: "errors", errors: { comment: "Add a comment first." } });
    return;
  }
  const { allowed } = await canResolveApproval(entry, clicker);
  if (!allowed) {
    await ack({ response_action: "errors", errors: { comment: "You're not allowed to decide this approval." } });
    return;
  }
  await ack();
  // Request-changes is a DENY that carries feedback — same shared applier, same card update.
  await applyApprovalDecision({ id, entry, durable, decision: "deny", comment, actorId: clicker, client });
}
